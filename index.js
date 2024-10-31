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
  .option('--min-replicas-count <number>', 'minimum replicas count', '3');

program.parse(process.argv);

const options = program.opts();

function parseBoolean(value) {
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return !!value;
}

const saveLog = options.out
  ? true
  : options.saveLog !== undefined
  ? parseBoolean(options.saveLog)
  : false;

const minReplicasCount = parseInt(options.minReplicasCount, 10) || 3;

async function initApi() {
  // 使用 Crust 网络的 WS 地址
  const chainWsUrl = 'wss://rpc.crust.network';

  const api = new ApiPromise({
    provider: new WsProvider(chainWsUrl),
    typesBundle: typesBundleForPolkadot,
  });

  await api.isReady;

  return api;
}

function parseLine(line) {
  // 去除两端的空白字符
  line = line.trim();

  if (!line) {
    return null; // 跳过空行
  }

  let i = line.length - 1;
  let fileSize = '';
  let fileCid = '';
  let fileName = '';

  // 步骤1：从右向左匹配数字作为 FILE_SIZE_IN_BYTES
  while (i >= 0 && /\d/.test(line.charAt(i))) {
    fileSize = line.charAt(i) + fileSize;
    i--;
  }

  if (!fileSize) {
    // 未找到文件大小
    return null;
  }

  // 步骤2：检查一个或多个空格或制表符
  while (i >= 0 && (line.charAt(i) === ' ' || line.charAt(i) === '\t')) {
    i--;
  }

  // 步骤3：匹配字母和数字作为 FILE_CID
  while (i >= 0 && /[A-Za-z0-9]/.test(line.charAt(i))) {
    fileCid = line.charAt(i) + fileCid;
    i--;
  }

  if (!fileCid) {
    // 未找到 CID
    return null;
  }

  // 步骤4：检查一个或多个空格或制表符
  while (i >= 0 && (line.charAt(i) === ' ' || line.charAt(i) === '\t')) {
    i--;
  }

  // 步骤5和6：剩余内容作为 FILE_NAME，移除任何 '/' 字符
  fileName = line.substring(0, i + 1).trim().replace(/\//g, '');

  if (!fileName) {
    // 未找到文件名
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

    // 获取当前区块号
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
        // 跳过格式不正确的行
        skippedLines.push({ lineNumber, line, reason: 'Incorrect format' });
      }
    }

    outputResults(results, skippedLines, saveLog, options);
    process.exit(0);
  });
}

function outputResults(results, skippedLines, saveLog, options) {
  const outputLines = [];

  // TABLE 1 头部
  outputLines.push('FILE_NAME\tFILE_CID\tFILE_SIZE\tFILE_ONCHAIN_STATUS\tFILE_REPLICAS');
  // 分隔符
  outputLines.push('----');

  // TABLE 1 数据
  results.forEach((item) => {
    outputLines.push(
      `${item.fileName}\t${item.fileCid}\t${item.fileSize}\t${item.fileOnchainStatus}\t${item.fileReplicas}`
    );
  });

  // 两个表之间的分隔符
  outputLines.push('====');

  // TABLE 2 头部
  outputLines.push('FILE_NAME\tFILE_CID\tFILE_SIZE(INPUT FILE SIZE ONLY)');
  // 分隔符
  outputLines.push('----');

  // TABLE 2 数据
  results
    .filter(
      (item) =>
        item.fileOnchainStatus !== 'Success' ||
        (item.fileOnchainStatus === 'Success' && item.fileReplicas < minReplicasCount)
    )
    .forEach((item) => {
      // 提取输入文件大小部分
      const inputFileSizeMatch = item.fileSize.match(/\((\d+)\)/);
      const inputFileSize = inputFileSizeMatch ? inputFileSizeMatch[1] : 'Unknown';

      outputLines.push(
        `${item.fileName}\t${item.fileCid}\t${inputFileSize}`
      );
    });

  if (saveLog) {
    const timestamp = new Date().getTime();
    const outputFileName = `check_status_${timestamp}.log`;
    const outputFilePath = options.out
      ? path.resolve(options.out)
      : path.join(process.cwd(), outputFileName);

    // 将结果写入文件
    fs.writeFileSync(outputFilePath, outputLines.join('\n'));

    console.log(`Results have been written to ${outputFilePath}`);

    // 读取并显示日志文件内容
    const logContent = fs.readFileSync(outputFilePath, 'utf8');
    console.log('Log file content:');
    console.log(logContent);
  } else {
    // 不保存日志文件，直接打印结果到控制台
    console.log('Results:');
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
  // 交互式输入
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '',
  });

  console.log('Please enter your input (press Ctrl+D when done to start querying):');
  rl.prompt();

  processLines(rl);
}
