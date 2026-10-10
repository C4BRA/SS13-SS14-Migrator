import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import * as fs from 'node:fs';
import { DMLexer } from '../parser/dmLexer.js';
import { DMParser } from '../parser/dmParser.js';
import { DMPreprocessor } from '../preprocessor.js';
import { RSIWriter } from '../dmi/rsiWriter.js';
import { MapConverter } from '../dmm/mapConverter.js';
import { DiagnosticCollector } from '../diagnostics.js';
import type {
  ParseFileResult,
  ResultMessage,
  TaskMessage,
  WarningsResult,
  WorkerInitData,
  WorkerTask,
} from './workerProtocol.js';

/**
 * Conversion worker: each instance is a plain node thread running the same
 * pipeline stages index.ts runs sequentially — per-file preprocess+lex+parse,
 * DMI→RSI, and DMM→grid-map. The shared #define seeds arrive via workerData
 * (structured clone) so each file still sees the pristine global macro
 * dictionary; the preprocessor's copy-on-write keeps per-file mutations local,
 * exactly like the sequential loop.
 */

const init = (workerData ?? {}) as WorkerInitData;
const rsiWriter = new RSIWriter();
const mapConverter = new MapConverter();

function runParseFile(filePath: string, relPath: string): ParseFileResult {
  // Same body as the sequential per-file loop in index.ts.
  const code = fs.readFileSync(filePath, 'utf-8');
  const collector = new DiagnosticCollector();
  collector.file = relPath;
  const preprocessor = new DMPreprocessor(collector, init.objectDefines, init.functionDefines);
  const processed = preprocessor.process(code, filePath);
  const lexer = new DMLexer(processed);
  const tokens = lexer.tokenize();
  collector.merge(lexer.diagnostics);
  const parser = new DMParser(tokens, collector);
  const nodes = parser.parse();
  return {
    nodes,
    globalVars: parser.globalVars,
    errors: [...collector.errors],
    warnings: [...collector.warnings],
  };
}

function runTask(task: WorkerTask): ParseFileResult | WarningsResult {
  switch (task.kind) {
    case 'parse':
      return runParseFile(task.filePath, task.relPath);
    case 'dmi': {
      const meta = rsiWriter.convertDMIToRSI(task.dmiPath, task.rsiPath);
      return { warnings: meta.warnings };
    }
    case 'dmm': {
      const mapData = mapConverter.convertDMMToSS14Map(task.dmmPath, task.yamlPath);
      return { warnings: mapData.warnings };
    }
  }
}

if (!isMainThread && parentPort) {
  parentPort.on('message', (msg: TaskMessage) => {
    const reply: ResultMessage = { seq: msg.seq, ok: false };
    try {
      reply.result = runTask(msg.task);
      reply.ok = true;
    } catch (err: any) {
      reply.error = err?.message ?? String(err);
      reply.stack = err?.stack;
    }
    parentPort!.postMessage(reply);
  });
}
