#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { typesBundleForPolkadot } = require('@crustio/type-definitions');
const { Command } = require('commander');
const readline = require('readline');

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

    console.log(`Connecting to ${chainWsUrl}...`);
    const api = new ApiPromise({
      provider: new WsProvider(chainWsUrl),
      typesBundle: typesBundleForPolkadot,
    });

    await api.isReady;
    console.log(`Successfully connected to ${chainWsUrl}`);
    return api;
  } catch (error) {
    console.error(`Failed to initialize API: ${error.message}`);
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

async function queryCidWithRetry(api, parsedLine, currentBlockNumber) {
  let attempts = 0;
  const maxAttempts = 3;
  let lastError = null;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      console.log(`Querying CID ${parsedLine.fileCid} (Attempt ${attempts}/${maxAttempts})`);
      
      const orderState = await api.query.market.filesV2(parsedLine.fileCid);
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
        fileName: parsedLine.fileName,
        fileCid: parsedLine.fileCid,
        fileSize: `${responseFileSize} (${parsedLine.fileSize})`,
        fileOnchainStatus,
        fileReplicas,
        success: true
      };
      
    } catch (error) {
      lastError = error;
      console.error(`Error querying CID ${parsedLine.fileCid} (Attempt ${attempts}/${maxAttempts}): ${error.message}`);
      
      if (attempts < maxAttempts) {
        // Wait before retrying
        const retryDelay = 2000; // 2 seconds
        console.log(`Retrying in ${retryDelay/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  // All attempts failed
  return {
    success: false,
    error: lastError ? lastError.message : 'Unknown error'
  };
}

async function processLines(rl) {
  const lines = [];
  
  rl.on('line', (line) => {
    lines.push(line);
  });

  rl.on('close', async () => {
    let api;
    try {
      api = await initApi();
    } catch (error) {
      console.error(`Failed to initialize API: ${error.message}`);
      // Don't exit, try to continue with the rest of the processing
      console.log('Continuing without API connection...');
    }

    if (!api) {
      console.error('No API connection available. Exiting...');
      process.exit(1);
    }

    const results = [];
    const skippedLines = [];

    // Get current block number
    let currentBlockNumber = 0;
    try {
      const currentBlock = await api.rpc.chain.getHeader();
      currentBlockNumber = currentBlock.number.toNumber();
      console.log(`Current block number: ${currentBlockNumber}`);
    } catch (error) {
      console.error(`Error getting current block: ${error.message}`);
      console.error('Continuing with block number set to 0...');
    }

    // Process each line individually
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      const line = lines[i];
      
      console.log(`Processing line ${lineNumber}/${lines.length}: ${line}`);
      
      const parsed = parseLine(line);
      if (!parsed) {
        console.log(`Line ${lineNumber}: Skipping - Incorrect format`);
        skippedLines.push({ lineNumber, line, reason: 'Incorrect format' });
        continue;
      }

      try {
        const queryResult = await queryCidWithRetry(api, parsed, currentBlockNumber);
        
        if (queryResult.success) {
          results.push(queryResult);
          console.log(`Successfully processed CID ${parsed.fileCid}`);
        } else {
          console.error(`Failed to process CID ${parsed.fileCid} after 3 attempts`);
          skippedLines.push({ 
            lineNumber, 
            line, 
            reason: `Failed after 3 attempts: ${queryResult.error}`,
            fileName: parsed.fileName,
            fileCid: parsed.fileCid,
            fileSize: parsed.fileSize
          });
        }
      } catch (error) {
        console.error(`Unexpected error processing line ${lineNumber}: ${error.message}`);
        skippedLines.push({ 
          lineNumber, 
          line, 
          reason: `Unexpected error: ${error.message}`,
          fileName: parsed.fileName,
          fileCid: parsed.fileCid,
          fileSize: parsed.fileSize
        });
      }
    }

    try {
      outputResults(results, skippedLines, saveLog, options);
    } catch (error) {
      console.error(`Error in outputResults: ${error.message}`);
      console.error(error.stack);
    } finally {
      if (api) {
        try {
          await api.disconnect();
          console.log('API disconnected');
        } catch (error) {
          console.error(`Error disconnecting API: ${error.message}`);
        }
      }
      process.exit(0);
    }
  });
}

function outputResults(results, skippedLines, saveLog, options) {
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

  // TABLE 3 for failed CIDs
  const table3Lines = [];
  table3Lines.push('FAILED CIDs (SKIPPED AFTER 3 ATTEMPTS)');
  table3Lines.push('FILE_NAME\tFILE_CID\tFILE_SIZE\tERROR_REASON');
  // Separator
  table3Lines.push('----');

  // Add failed CIDs to table3
  const failedCids = skippedLines.filter(item => item.fileName && item.fileCid && item.fileSize !== undefined);
  failedCids.forEach((item) => {
    table3Lines.push(`${item.fileName}\t${item.fileCid}\t${item.fileSize}\t${item.reason}`);
  });

  if (saveLog) {
    let outputLines = [];

    if (saveLogMode === 'default') {
      // Include TABLE1, TABLE2, and TABLE3 with headers
      outputLines.push(...table1Lines);
      outputLines.push('====');
      outputLines.push(...table2Lines);
      
      // Only add TABLE3 if there are failed CIDs
      if (failedCids.length > 0) {
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
      
      // Only add TABLE3 if there are failed CIDs
      if (failedCids.length > 0) {
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

    try {
      // Write the results to file
      fs.writeFileSync(outputFilePath, outputLines.join('\n'));
      console.log(`Results have been written to ${outputFilePath}`);

      // Read and display log file content
      const logContent = fs.readFileSync(outputFilePath, 'utf8');
      console.log('Log file content:');
      console.log(logContent);
    } catch (error) {
      console.error(`Error writing to file: ${error.message}`);
    }
  } else {
    // Do not save log file, output results to console
    console.log('Results:');
    let outputLines = [];
    outputLines.push(...table1Lines);
    outputLines.push('====');
    outputLines.push(...table2Lines);
    
    // Only add TABLE3 if there are failed CIDs
    if (failedCids.length > 0) {
      outputLines.push('====');
      outputLines.push(...table3Lines);
    }
    
    console.log(outputLines.join('\n'));
  }

  if (skippedLines.length > 0) {
    console.log('\nThe following lines were skipped due to errors:');
    skippedLines.forEach((item) => {
      console.log(`Line ${item.lineNumber}: ${item.reason}`);
      if (item.fileName && item.fileCid) {
        console.log(`File info: ${item.fileName} ${item.fileCid} ${item.fileSize}`);
      }
    });
  }
}

if (options.input) {
  const inputFilePath = path.resolve(options.input);
  try {
    const inputStream = fs.createReadStream(inputFilePath);
    
    inputStream.on('error', (error) => {
      console.error(`Error reading input file: ${error.message}`);
      process.exit(1);
    });

    const rl = readline.createInterface({
      input: inputStream,
      crlfDelay: Infinity,
    });

    processLines(rl);
  } catch (error) {
    console.error(`Error setting up input stream: ${error.message}`);
    process.exit(1);
  }
} else {
  // Interactive input
  try {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '',
    });

    console.log('Please enter your input (press Ctrl+D when done to start querying):');
    rl.prompt();

    processLines(rl);
  } catch (error) {
    console.error(`Error setting up interactive input: ${error.message}`);
    process.exit(1);
  }
}
