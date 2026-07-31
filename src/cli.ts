#!/usr/bin/env node
import { DM2SS14Transpiler } from './index.js';
import { GUIServer } from './gui/server.js';
import * as path from 'path';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('gui') || args.length === 0) {
    const guiServer = new GUIServer(3456);
    guiServer.start();
    return;
  }

  let inputDir = '';
  let outputDir = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' || args[i] === '-i') {
      inputDir = args[i + 1];
      i++;
    } else if (args[i] === '--output' || args[i] === '-o') {
      outputDir = args[i + 1];
      i++;
    }
  }

  if (!inputDir || !outputDir) {
    console.log(`
Usage: dm2ss14 convert --input <ss13-repo-path> --output <ss14-output-path>

Options:
  -i, --input <path>   Path to SS13 BYOND repository directory
  -o, --output <path>  Path to output SS14 C# solution directory
`);
    process.exit(1);
  }

  const transpiler = new DM2SS14Transpiler();
  try {
    await transpiler.transpile({
      inputDir: path.resolve(inputDir),
      outputDir: path.resolve(outputDir)
    });
  } catch (err: any) {
    console.error(`[dm2ss14] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
