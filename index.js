#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { typesBundleForPolkadot } = require('@crustio/type-definitions');
const { Command } = require('commander');
const readline = require('readline');

// JSDoc type definitions instead of TypeScript interfaces
/**
 * @typedef {Object} ParsedLine
 * @property {string} fileName
 * @property {string} fileCid
 * @property {number} fileSize
 */

/**
 * @typedef {Object} ResultItem
 * @property {string} fileName
 * @property {string} fileCid
 * @property {string} fileSize
 * @property {string} fileOnchainStatus
 * @property {number} fileReplicas
 */

/**
 * @typedef {Object} SkippedLine
 * @property {number} lineNumber
 * @property {string} line
 * @property {string} reason
 * @property {ParsedLine} [parsedData]
 */

const program = new Command();

program
  .option('--input <path>', 'path to input text file')
  .option('--out <path>', 'path to output log file')
  .option('--save-log <boolean>', 'whether to save log file (true/false)')
  .option('--min-replicas-count <number>', 'minimum replicas count', '3')
  .option('--save-log-mode <mode>', "log save mode: 'default' or 'table2'", 'default')
  .option('--address <url>', 'Crust Network WebSocket address', 'wss://rpc-crust-mainnet.decoo.io/');

program.parse(process.argv);

const options = program.opts();

function parseBoolean(value) {
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return !!value;
}

const minReplicasCount = parseInt(options.minReplicasCount, 10) || 3;

// Determine if the user specified --save-log-mode
const saveLogModeSpecified =
  program.getOptionValueSource('saveLogMode') !== 'default';

const saveLogMode = options.saveLogMode || 'default';

let saveLog;
if (saveLogModeSpecified) {
  // When --save-log-mode is specified, saveLog is true regardless of --save-log
  saveLog = true;
} else if (options.out) {
  saveLog = true;
} else if (options.saveLog !== undefined) {
  saveLog = parseBoolean(options.saveLog);
} else {
  saveLog = false;
}

async function initApi() {
  try {
    // Use Crust Network's WS address from command line or default
    let chainWsUrl = options.address;
    
    // Normalize URL by removing trailing slash if present
    chainWsUrl = chainWsUrl.endsWith('/') ? chainWsUrl.slice(0, -1) : chainWsUrl;

    const api = new ApiPromise({
      provider: new WsProvider(chainWsUrl),
      typesBundle: typesBundleForPolkadot,
    });

    await api.isReady;
    return api;
  } catch (error) {
    console.error(`Error initializing API: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function parseLine(line) {
  // Trim whitespace
  line = line.trim();

  if (!line) {
    return null; // Skip empty lines
  }

  let i = line.length - 1;
  let fileSize = '';
  let fileCid = '';
  let fileName = '';

  // Step 1: Match digits from right to left as FILE_SIZE_IN_BYTES
  while (i >= 0 && /\d/.test(line.charAt(i))) {
    fileSize = line.charAt(i) + fileSize;
    i--;
  }

  if (!fileSize) {
    // File size not found
    return null;
  }

  // Step 2: Check for spaces or tabs
  while (i >= 0 && (line.charAt(i) === ' ' || line.charAt(i) === '\t')) {
    i--;
  }

  // Step 3: Match alphanumeric characters as FILE_CID
  while (i >= 0 && /[A-Za-z0-9]/.test(line.charAt(i))) {
    fileCid = line.charAt(i) + fileCid;
    i--;
  }

  if (!fileCid) {
    // CID not found
    return null;
  }

  // Step 4: Check for spaces or tabs
  while (i >= 0 && (line.charAt(i) === ' ' || line.charAt(i) === '\t')) {
    i--;
  }

  // Steps 5 and 6: Remaining content as FILE_NAME, remove any '/' characters
  fileName = line.substring(0, i + 1).trim().replace(/\//g, '');

  if (!fileName) {
    // File name not found
    return null;
  }

  return {
    fileName,
    fileCid,
    fileSize: parseInt(fileSize, 10),
  };
}

// Helper function for retrying API calls with exponential backoff
async function retryOperation(
  operation,
  maxRetries = 3,
  initialDelay = 1000,
  factor = 2
) {
  let currentRetry = 0;
  let delay = initialDelay;

  while (true) {
    try {
      return await operation();
    } catch (err) {
      currentRetry++;
      if (currentRetry >= maxRetries) {
        throw err; // Max retries reached, re-throw the error
      }
      
      // Wait for a delay before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= factor; // Exponential backoff
    }
  }
}

async function queryFileCid(api, fileCid, currentBlockNumber) {
  return retryOperation(async () => {
    const orderState = await api.query.market.filesV2(fileCid);
    const orderJson = orderState.toJSON();
    
    let fileOnchainStatus = 'NotFound';
    let fileReplicas = 0;
    let responseFileSize = 'Unknown';

    if (orderJson && orderJson.file_size) {
      responseFileSize = orderJson.file_size;
      fileReplicas = parseInt(orderJson.reported_replica_count || 0, 10);

      const expiredAt = orderJson.expired_at || 0;

      if (currentBlockNumber >= expiredAt) {
        fileOnchainStatus = 'Expired';
      } else if (fileReplicas > 0) {
        fileOnchainStatus = 'Success';
      } else {
        fileOnchainStatus = 'Pending';
      }
    } else {
      fileOnchainStatus = 'NotFound';
    }

    return {
      fileOnchainStatus,
      fileReplicas,
      responseFileSize
    };
  });
}

async function processLines(rl) {
  try {
    const lines = [];
    
    // Read all lines into memory first
    await new Promise((resolve) => {
      rl.on('line', (line) => {
        lines.push(line);
      });
      
      rl.on('close', () => {
        resolve();
      });
    });

    let api;
    let currentBlockNumber;
    
    try {
      // Initialize API once before processing
      api = await initApi();
      
      // Get current block number
      const currentBlock = await api.rpc.chain.getHeader();
      currentBlockNumber = currentBlock.number.toNumber();
    } catch (error) {
      console.error(`Fatal error initializing API: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    const results = [];
    const skippedLines = [];

    // Process each line sequentially
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      const line = lines[i];
      const parsed = parseLine(line);
      
      if (!parsed) {
        // Skip incorrectly formatted lines
        skippedLines.push({ lineNumber, line, reason: 'Incorrect format' });
        continue;
      }
      
      try {
        const queryResult = await queryFileCid(api, parsed.fileCid, currentBlockNumber);
        
        results.push({
          fileName: parsed.fileName,
          fileCid: parsed.fileCid,
          fileSize: `${queryResult.responseFileSize} (${parsed.fileSize})`,
          fileOnchainStatus: queryResult.fileOnchainStatus,
          fileReplicas: queryResult.fileReplicas,
        });
        
        // Log progress
        process.stdout.write(`Processed ${lineNumber}/${lines.length}: ${parsed.fileCid}\r`);
      } catch (error) {
        // If all retries failed, log the error and continue with next CID
        console.error(`\nError querying CID ${parsed.fileCid} after 3 retries: ${error instanceof Error ? error.message : String(error)}`);
        skippedLines.push({ 
          lineNumber, 
          line, 
          reason: `Query failed after retries: ${error instanceof Error ? error.message : String(error)}`,
          parsedData: parsed
        });
      }
    }

    // Make sure to close the API connection
    if (api) {
      await api.disconnect();
    }

    // Output results
    outputResults(results, skippedLines, saveLog, options);
    
  } catch (error) {
    console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function outputResults(
  results, 
  skippedLines, 
  saveLog, 
  options
) {
  try {
    const saveLogMode = options.saveLogMode || 'default';
    const minReplicasCount = parseInt(options.minReplicasCount, 10) || 3;

    const table1Lines = [];
    // TABLE 1 HEADER
    table1Lines.push('FILE_NAME\tFILE_CID\tFILE_SIZE\tFILE_ONCHAIN_STATUS\tFILE_REPLICAS');
    // Separator
    table1Lines.push('----');

    // TABLE 1 DATA
    results.forEach((item) => {
      table1Lines.push(
        `${item.fileName}\t${item.fileCid}\t${item.fileSize}\t${item.fileOnchainStatus}\t${item.fileReplicas}`
      );
    });

    // TABLE 2 HEADER
    const table2Lines = [];
    table2Lines.push('FILE_NAME\tFILE_CID\tFILE_SIZE(INPUT FILE SIZE ONLY)');
    // Separator
    table2Lines.push('----');

    const table2Data = results
      .filter(
        (item) =>
          item.fileOnchainStatus !== 'Success' ||
          (item.fileOnchainStatus === 'Success' && item.fileReplicas < minReplicasCount)
      )
      .map((item) => {
        // Extract input file size part
        const inputFileSizeMatch = item.fileSize.match(/\((\d+)\)/);
        const inputFileSize = inputFileSizeMatch ? inputFileSizeMatch[1] : 'Unknown';

        return `${item.fileName}\t${item.fileCid}\t${inputFileSize}`;
      });

    table2Lines.push(...table2Data);

    // TABLE 3 for skipped CIDs with parsed data
    const table3Lines = [];
    table3Lines.push('SKIPPED_FILE_NAME\tSKIPPED_FILE_CID\tSKIPPED_FILE_SIZE\tREASON');
    // Separator
    table3Lines.push('----');

    // Only include skipped lines where we have parsed data
    const skippedWithData = skippedLines.filter(item => item.parsedData);
    if (skippedWithData.length > 0) {
      skippedWithData.forEach(item => {
        if (item.parsedData) {
          table3Lines.push(
            `${item.parsedData.fileName}\t${item.parsedData.fileCid}\t${item.parsedData.fileSize}\t${item.reason}`
          );
        }
      });
    }

    if (saveLog) {
      let outputLines = [];

      if (saveLogMode === 'default') {
        // Include TABLE1, TABLE2, and TABLE3 with headers
        outputLines.push(...table1Lines);
        outputLines.push('====');
        outputLines.push(...table2Lines);
        
        if (skippedWithData.length > 0) {
          outputLines.push('====');
          outputLines.push(...table3Lines);
        }
      } else if (saveLogMode === 'table2') {
        if (table2Data.length === 0) {
          // TABLE2 is empty
          console.log('TABLE2 is empty, no log file generated');
          // Skip generating the log file
          return;
        } else {
          // Output only TABLE2 data, without headers
          outputLines.push(...table2Data);
        }
      } else {
        // Default behavior
        outputLines.push(...table1Lines);
        outputLines.push('====');
        outputLines.push(...table2Lines);
        
        if (skippedWithData.length > 0) {
          outputLines.push('====');
          outputLines.push(...table3Lines);
        }
      }

      // Write outputLines to file
      const timestamp = new Date().getTime();
      const outputFileName = `check_status_${timestamp}.log`;
      const outputFilePath = options.out
        ? path.resolve(options.out)
        : path.join(process.cwd(), outputFileName);

      // Write the results to file
      fs.writeFileSync(outputFilePath, outputLines.join('\n'));

      console.log(`\nResults have been written to ${outputFilePath}`);

      // Read and display log file content
      const logContent = fs.readFileSync(outputFilePath, 'utf8');
      console.log('Log file content:');
      console.log(logContent);
    } else {
      // Do not save log file, output results to console
      console.log('\nResults:');
      let outputLines = [];
      outputLines.push(...table1Lines);
      outputLines.push('====');
      outputLines.push(...table2Lines);
      
      if (skippedWithData.length > 0) {
        outputLines.push('====');
        outputLines.push(...table3Lines);
      }
      
      console.log(outputLines.join('\n'));
    }

    if (skippedLines.length > 0) {
      console.log('\nThe following lines were skipped due to errors:');
      skippedLines.forEach((item) => {
        console.log(`Line ${item.lineNumber}: ${item.reason}`);
      });
    }
  } catch (error) {
    console.error(`Error in outputResults: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Add global error handling
process.on('uncaughtException', (error) => {
  console.error(`Uncaught exception: ${error.message}`);
  console.error(error.stack);
  // Don't exit the process
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process
});

// Main function
async function main() {
  try {
    if (options.input) {
      const inputFilePath = path.resolve(options.input);
      const inputStream = fs.createReadStream(inputFilePath);

      const rl = readline.createInterface({
        input: inputStream,
        crlfDelay: Infinity,
      });

      await processLines(rl);
    } else {
      // Interactive input
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '',
      });

      console.log('Please enter your input (press Ctrl+D when done to start querying):');
      rl.prompt();

      await processLines(rl);
    }
    
    // Successful exit
    process.exit(0);
  } catch (error) {
    console.error(`Fatal error in main: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Start the program
main().catch(error => {
  console.error(`Startup error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
