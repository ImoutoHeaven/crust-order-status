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
  .option('--out <path>', 'path to output log file');

program.parse(process.argv);

const options = program.opts();

async function initApi() {
  // Use Crust network's WS address
  const chainWsUrl = 'wss://rpc.crust.network';

  const api = new ApiPromise({
    provider: new WsProvider(chainWsUrl),
    typesBundle: typesBundleForPolkadot,
  });

  await api.isReady;

  return api;
}

function parseLine(line) {
  // Trim whitespace from both ends
  line = line.trim();

  if (!line) {
    return null; // Skip empty lines
  }

  let i = line.length - 1;
  let fileSize = '';
  let fileCid = '';
  let fileName = '';

  // Step 1: From right to left, match digits for FILE_SIZE_IN_BYTES
  while (i >= 0 && /\d/.test(line.charAt(i))) {
    fileSize = line.charAt(i) + fileSize;
    i--;
  }

  if (!fileSize) {
    // No file size found
    return null;
  }

  // Step 2: Check for one or more spaces or tabs
  while (i >= 0 && (line.charAt(i) === ' ' || line.charAt(i) === '\t')) {
    i--;
  }

  // Step 3: Match letters and digits for FILE_CID
  while (i >= 0 && /[A-Za-z0-9]/.test(line.charAt(i))) {
    fileCid = line.charAt(i) + fileCid;
    i--;
  }

  if (!fileCid) {
    // No CID found
    return null;
  }

  // Step 4: Check for one or more spaces or tabs
  while (i >= 0 && (line.charAt(i) === ' ' || line.charAt(i) === '\t')) {
    i--;
  }

  // Step 5 and 6: Remaining content is FILE_NAME, remove any '/' characters
  fileName = line.substring(0, i + 1).trim().replace(/\//g, '');

  if (!fileName) {
    // No file name found
    return null;
  }

  return {
    fileName,
    fileCid,
    fileSize: parseInt(fileSize),
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
            fileReplicas = orderJson.reported_replica_count || 0;

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
        // Skip lines with incorrect format
        skippedLines.push({ lineNumber, line, reason: 'Incorrect format' });
      }
    }

    outputResults(results, skippedLines);
    process.exit(0);
  });
}

function outputResults(results, skippedLines) {
  const timestamp = new Date().getTime();
  const outputFileName = `check_status_${timestamp}.log`;
  const outputFilePath = options.out
    ? path.resolve(options.out)
    : path.join(process.cwd(), outputFileName);

  const outputLines = [];

  // Table 1 header
  outputLines.push('FILE_NAME\tFILE_CID\tFILE_SIZE\tFILE_ONCHAIN_STATUS\tFILE_REPLICAS');
  // Separator
  outputLines.push('----');

  // Table 1 data
  results.forEach((item) => {
    outputLines.push(
      `${item.fileName}\t${item.fileCid}\t${item.fileSize}\t${item.fileOnchainStatus}\t${item.fileReplicas}`
    );
  });

  // Separator between tables
  outputLines.push('====');

  // Table 2 header
  outputLines.push('FILE_NAME FILE_CID FILE_SIZE(INPUT FILE SIZE ONLY)');
  // Separator
  outputLines.push('----');

  // Table 2 data
  results
    .filter((item) => item.fileOnchainStatus !== 'Success')
    .forEach((item) => {
      outputLines.push(
        `${item.fileName} ${item.fileCid} ${item.fileSize.split('(')[1].replace(')', '')}`
      );
    });

  // Write results to file
  fs.writeFileSync(outputFilePath, outputLines.join('\n'));

  console.log(`Results have been written to ${outputFilePath}`);

  // Read and display log file content
  const logContent = fs.readFileSync(outputFilePath, 'utf8');
  console.log('Log file content:');
  console.log(logContent);

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
