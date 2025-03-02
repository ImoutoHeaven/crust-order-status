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
  // Use Crust Network's WS address from command line or default
  const chainWsUrl = options.address;

  const api = new ApiPromise({
    provider: new WsProvider(chainWsUrl),
    typesBundle: typesBundleForPolkadot,
  });

  await api.isReady;

  return api;
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

async function processLines(rl) {
  const lines = [];
  const skippedLines = [];
  rl.on('line', (line) => {
    lines.push(line);
  });

  rl.on('close', async () => {
    const api = await initApi();

    const results = [];

    // Get current block number
    const currentBlock = await api.rpc.chain.getHeader();
    const currentBlockNumber = currentBlock.number.toNumber();

    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      const line = lines[i];
      const parsed = parseLine(line);
      if (parsed) {
        try {
          const orderState = await api.query.market.filesV2(parsed.fileCid);
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

          results.push({
            fileName: parsed.fileName,
            fileCid: parsed.fileCid,
            fileSize: `${responseFileSize} (${parsed.fileSize})`,
            fileOnchainStatus,
            fileReplicas,
          });
        } catch (error) {
          console.error(`Error querying CID ${parsed.fileCid}: ${error.message}`);
          skippedLines.push({ lineNumber, line, reason: error.message });
        }
      } else {
        // Skip incorrectly formatted lines
        skippedLines.push({ lineNumber, line, reason: 'Incorrect format' });
      }
    }

    outputResults(results, skippedLines, saveLog, options);
    process.exit(0);
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

  if (saveLog) {
    let outputLines = [];

    if (saveLogMode === 'default') {
      // Include TABLE1 and TABLE2 with headers
      outputLines.push(...table1Lines);
      outputLines.push('====');
      outputLines.push(...table2Lines);
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
    }

    // Write outputLines to file
    const timestamp = new Date().getTime();
    const outputFileName = `check_status_${timestamp}.log`;
    const outputFilePath = options.out
      ? path.resolve(options.out)
      : path.join(process.cwd(), outputFileName);

    // Write the results to file
    fs.writeFileSync(outputFilePath, outputLines.join('\n'));

    console.log(`Results have been written to ${outputFilePath}`);

    // Read and display log file content
    const logContent = fs.readFileSync(outputFilePath, 'utf8');
    console.log('Log file content:');
    console.log(logContent);
  } else {
    // Do not save log file, output results to console
    console.log('Results:');
    let outputLines = [];
    outputLines.push(...table1Lines);
    outputLines.push('====');
    outputLines.push(...table2Lines);
    console.log(outputLines.join('\n'));
  }

  if (skippedLines.length > 0) {
    console.log('The following lines were skipped due to errors:');
    skippedLines.forEach((item) => {
      console.log(`Line ${item.lineNumber}: ${item.reason}`);
    });
  }
}

if (options.input) {
  const inputFilePath = path.resolve(options.input);
  const inputStream = fs.createReadStream(inputFilePath);

  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Infinity,
  });

  processLines(rl);
} else {
  // Interactive input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '',
  });

  console.log('Please enter your input (press Ctrl+D when done to start querying):');
  rl.prompt();

  processLines(rl);
}
