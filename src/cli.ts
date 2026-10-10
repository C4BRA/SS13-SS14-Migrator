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
  let jobs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' || args[i] === '-i') {
      inputDir = args[i + 1];
      i++;
    } else if (args[i] === '--output' || args[i] === '-o') {
      outputDir = args[i + 1];
      i++;
    } else if (args[i] === '--jobs' || args[i] === '-j' || args[i].startsWith('--jobs=') || /^-j\d+$/.test(args[i])) {
      let raw: string | undefined;
      if (args[i].startsWith('--jobs=')) raw = args[i].slice('--jobs='.length);
      else if (/^-j\d+$/.test(args[i])) raw = args[i].slice(2);
      else { raw = args[i + 1]; i++; }
      const parsed = Number(raw);
      if (raw === undefined || !Number.isFinite(parsed) || parsed < 0) {
        console.error(`[dm2ss14] Error: --jobs expects a non-negative integer (got '${raw}').`);
        process.exit(1);
      }
      jobs = Math.floor(parsed);
    }
  }

  if (!inputDir || !outputDir) {
    console.log(`
Usage: dm2ss14 convert --input <ss13-repo-path> --output <ss14-output-path>

Options:
  -i, --input <path>   Path to SS13 BYOND repository directory
  -o, --output <path>  Path to output SS14 C# solution directory
  -j, --jobs <N>       Worker threads for parse/DMI/DMM stages
                       (0 or omit = auto; 1 = sequential)
`);
    process.exit(1);
  }

  // Reject output paths outside the user's home — parity with the GUI's
  // realpath check (item 61): `~/x` is expanded and symlinks pointing
  // outside $HOME are refused.
  const validatedOutput = GUIServer.validateOutputPath(outputDir);
  if (validatedOutput === null) {
    console.error(`[dm2ss14] Error: --output must be inside your home directory (got '${outputDir}').`);
    process.exit(1);
  }

  const transpiler = new DM2SS14Transpiler();
  try {
    await transpiler.transpile({
      inputDir: path.resolve(inputDir),
      outputDir: validatedOutput,
      jobs
    });
  } catch (err: any) {
    console.error(`[dm2ss14] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
