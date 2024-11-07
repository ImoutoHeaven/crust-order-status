# Crust File Status Checker

A command-line tool to check the storage status of files on the Crust Network. This tool allows you to verify file replication status, size, and other on-chain information for files stored on Crust Network.

## Features

- Check file storage status on Crust Network
- Support for batch processing via input file
- Interactive input mode
- Configurable minimum replicas count
- Flexible logging options with different output formats
- Cross-platform support (Linux, Windows)

## Prerequisites

- Node.js 18 or higher
- npm or yarn package manager

## Installation

### From Source

1. Clone the repository:
```bash
git clone https://github.com/ImoutoHeaven/crust-order-status.git
cd crust-file-status-checker
```

2. Install dependencies:
```bash
npm install
# or
yarn install
```

### Using Binary

Pre-built binaries are available for the following platforms:
- Linux (ARM64)
- Linux (x64)
- Windows (x64)

Download the appropriate binary for your platform from the releases page.

## Compilation Guide

To compile the application into standalone binaries:

1. Install development dependencies:
```bash
npm install
# or
yarn install
```

2. Build the binaries:
```bash
npm run build
# or
yarn build
```

This will create executables in the `dist` directory for the following platforms:
- `crust-file-status-checker-linux-arm64`
- `crust-file-status-checker-linux-x64`
- `crust-file-status-checker-win-x64.exe`

## Usage

### Input Format

Each line in the input should follow this format:
```
FILE_NAME FILE_CID FILE_SIZE_IN_BYTES
```

Example:
```
example.txt QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 1234567
```

### Command Line Options

```
Options:
  --input <path>                 Path to input text file
  --out <path>                   Path to output log file
  --save-log <boolean>           Whether to save log file (true/false)
  --min-replicas-count <number>  Minimum replicas count (default: 3)
  --save-log-mode <mode>         Log save mode: 'default' or 'table2' (default: 'default')
```

### Running the Tool

#### Interactive Mode
```bash
node index.js
# or if using binary
./crust-file-status-checker
```

#### File Input Mode
```bash
node index.js --input input.txt --save-log true
# or if using binary
./crust-file-status-checker --input input.txt --save-log true
```

### Output Format

The tool generates two tables:

#### Table 1
Contains complete information for all files:
- FILE_NAME
- FILE_CID
- FILE_SIZE
- FILE_ONCHAIN_STATUS
- FILE_REPLICAS

#### Table 2
Contains files that either:
- Are not successfully stored
- Have fewer replicas than the minimum requirement

## Log Modes

### Default Mode
Includes both Table 1 and Table 2 in the output.

### Table2 Mode
Only outputs Table 2, which is useful for identifying files that need attention.
```bash
node index.js --input input.txt --save-log-mode table2
```

## License

ISC

## Dependencies

- @polkadot/api: Polkadot/Substrate API wrapper
- @crustio/type-definitions: Crust Network type definitions
- commander: Command-line interface
- readline: Interactive input handling
