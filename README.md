
# Crust Order Check

`Crust Order Check` is a Node.js-based CLI tool for checking the on-chain order status of NFT files on the [Crust Network](https://crust.network/). 
This tool interacts with Crust's decentralized storage to monitor file storage status, helping users verify NFT file replicas, storage status, and order details. 
The project supports CLI inputs and can output results in a structured log file.

## Features
- Query the on-chain storage status of NFT files based on CID.
- Supports command-line input of CID lists from a text file.
- Outputs order status, replica count, and storage details for each file.
- Auto-generates a structured log file of results with customizable output location.

---

## Requirements
- Node.js (version 18 or higher is recommended)
- npm (Node package manager)

To install Node.js and npm, follow the instructions on [Node.js official website](https://nodejs.org/).

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/ImoutoHeaven/crust-order-status.git
cd crust-order-status
npm install
```

## Compilation (Optional)

To compile this project into standalone executables for different platforms, `pkg` is used. Run the following command to install `pkg` as a development dependency:

```bash
npm install pkg --save-dev
```

Then, you can compile the project for Linux, Windows, and macOS:


```bash
npm run build
```

This will generate executables in the root directory for platform defined at ```package.json```.

---

## Usage

### CLI Usage

The tool accepts command-line arguments for input and output:

```bash
node index.js --input /path/to/text_file --out /path/to/log/file
```

- `--input` (optional): The path to the text file containing CIDs and file details. If --input arg is omitted, program will ask for user-input interactively.
- `--out` (optional): The path to save the generated log file. If omitted, the log file will be saved in the current directory.

The input text file should be structured as follows:

```
<FILE_NAME1> <FILE_CID1> <INPUT_FILE_SIZE_1>
<FILE_NAME2> <FILE_CID2> <INPUT_FILE_SIZE_2>
```

Each line represents one file, with file name, CID, and file size separated by spaces or tabs.

### Usage Example

Example `input.txt` file:

```
MyFile QmTmSeh1vU6gXe1J8L2W8qY6X5oYx4GLjCzSyhTYehH7aV 123456
AnotherFile QmYwAPJzv5CZsnAzt8auVZRn2tW9vJYw4KPsxX8bQ 789012
```

Run the tool:

```bash
node index.js --input ./input.txt --out ./output.log
```

Sample output in `output.log`:

```
FILE_NAME	FILE_CID	FILE_SIZE	FILE_ONCHAIN_STATUS	FILE_REPLICAS
----
MyFile	QmTmSeh1vU6gXe1J8L2W8qY6X5oYx4GLjCzSyhTYehH7aV	Unknown (123456)	NotFound	0
AnotherFile	QmYwAPJzv5CZsnAzt8auVZRn2tW9vJYw4KPsxX8bQ	Unknown (789012)	NotFound	0
====
FILE_NAME FILE_CID FILE_SIZE(INPUT FILE SIZE ONLY)
----
MyFile QmTmSeh1vU6gXe1J8L2W8qY6X5oYx4GLjCzSyhTYehH7aV 123456
AnotherFile QmYwAPJzv5CZsnAzt8auVZRn2tW9vJYw4KPsxX8bQ 789012
```

---

## Additional Notes
- The tool connects to Crust Network via the WebSocket endpoint `wss://rpc.crust.network`. Ensure network access to this endpoint.
- The log file includes table separators (`----` and `====`) for easy readability and parsing.

## License

This project is licensed under the [MIT License](LICENSE).
