#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("./index.js");
const server_js_1 = require("./gui/server.js");
const path = __importStar(require("path"));
async function main() {
    const args = process.argv.slice(2);
    if (args.includes('gui') || args.length === 0) {
        const guiServer = new server_js_1.GUIServer(3456);
        guiServer.start();
        return;
    }
    let inputDir = '';
    let outputDir = '';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--input' || args[i] === '-i') {
            inputDir = args[i + 1];
            i++;
        }
        else if (args[i] === '--output' || args[i] === '-o') {
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
    // Reject output paths outside the user's home — parity with the GUI's
    // realpath check (item 61): `~/x` is expanded and symlinks pointing
    // outside $HOME are refused.
    const validatedOutput = server_js_1.GUIServer.validateOutputPath(outputDir);
    if (validatedOutput === null) {
        console.error(`[dm2ss14] Error: --output must be inside your home directory (got '${outputDir}').`);
        process.exit(1);
    }
    const transpiler = new index_js_1.DM2SS14Transpiler();
    try {
        await transpiler.transpile({
            inputDir: path.resolve(inputDir),
            outputDir: validatedOutput
        });
    }
    catch (err) {
        console.error(`[dm2ss14] Error: ${err.message}`);
        process.exit(1);
    }
}
main();
