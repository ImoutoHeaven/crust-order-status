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
  // 使用Crust网络的WS地址
  const chainWsUrl = 'wss://rpc.crust.network';

  const api = new ApiPromise({
    provider: new WsProvider(chainWsUrl),
    typesBundle: typesBundleForPolkadot,
  });

  await api.isReady;

  return api;
}

function parseLine(line) {
  // 去除两端空白
  line = line.trim();

  if (!line) {
    return null; // 跳过空行
  }

  let i = line.length - 1;
  let fileSize = '';
  let fileCid = '';
  let fileName = '';

  let state = 0;

  while (i >= 0) {
    const char = line.charAt(i);

    if (state === 0) {
      // 解析文件大小
      if (/\d/.test(char)) {
        fileSize = char + fileSize;
        i--;
      } else if (char === ' ' || char === '\t') {
        state = 1;
        i--;
      } else {
        // 文件大小中存在非法字符
        return null;
      }
    } else if (state === 1) {
      // 解析CID
      if (/[A-Za-z0-9]/.test(char)) {
        fileCid = char + fileCid;
        i--;
      } else if (char === ' ' || char === '\t') {
        state = 2;
        i--;
      } else {
        // CID中存在非法字符
        return null;
      }
    } else if (state === 2) {
      // 解析文件名
      fileName = line.substring(0, i + 1).trim();
      break;
    }
  }

  if (!fileName || !fileCid || !fileSize) {
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

    // 获取当前区块高度
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
            fileReplicas
          });
        } catch (error) {
          console.error(`查询CID ${parsed.fileCid} 时出错: ${error.message}`);
          skippedLines.push({ lineNumber, line, reason: error.message });
        }
      } else {
        // 跳过格式错误的行
        skippedLines.push({ lineNumber, line, reason: '格式错误' });
      }
    }

    outputResults(results, skippedLines);
    process.exit(0);
  });
}

function outputResults(results, skippedLines) {
  const timestamp = new Date().getTime();
  const outputFileName = `check_status_${timestamp}.log`;
  const outputFilePath = options.out ? path.resolve(options.out) : path.join(process.cwd(), outputFileName);

  const outputLines = [];

  // 表格1的标题
  outputLines.push('FILE_NAME\tFILE_CID\tFILE_SIZE\tFILE_ONCHAIN_STATUS\tFILE_REPLICAS');
  // 添加分隔符
  outputLines.push('----');

  // 表格1的数据
  results.forEach((item) => {
    outputLines.push(`${item.fileName}\t${item.fileCid}\t${item.fileSize}\t${item.fileOnchainStatus}\t${item.fileReplicas}`);
  });

  // 分隔表格1和表格2
  outputLines.push('====');

  // 表格2的标题
  outputLines.push('FILE_NAME FILE_CID FILE_SIZE(INPUT FILE SIZE ONLY)');
  // 添加分隔符
  outputLines.push('----');

  // 表格2的数据
  results.filter(item => item.fileOnchainStatus !== 'Success').forEach((item) => {
    outputLines.push(`${item.fileName} ${item.fileCid} ${item.fileSize.split('(')[1].replace(')', '')}`);
  });

  // 将结果写入文件
  fs.writeFileSync(outputFilePath, outputLines.join('\n'));

  console.log(`结果已写入 ${outputFilePath}`);

  // 读取并显示日志文件内容
  const logContent = fs.readFileSync(outputFilePath, 'utf8');
  console.log('日志文件内容如下：');
  console.log(logContent);

  if (skippedLines.length > 0) {
    console.log('以下行因错误被跳过:');
    skippedLines.forEach((item) => {
      console.log(`第 ${item.lineNumber} 行: ${item.reason}`);
    });
  }
}

if (options.input) {
  const inputFilePath = path.resolve(options.input);
  const inputStream = fs.createReadStream(inputFilePath);

  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Infinity
  });

  processLines(rl);
} else {
  // 交互式输入
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: ''
  });

  console.log('请输入您的输入（输入完成后按 Ctrl+D 开始执行查询）：');
  rl.prompt();

  processLines(rl);
}

