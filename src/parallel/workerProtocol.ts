import type { Diagnostic } from '../diagnostics.js';
import type { FunctionMacro } from '../preprocessor.js';

/**
 * Tasks dispatched to the conversion worker pool (src/parallel/parseWorker.ts).
 * Every task is fully independent: workers get the shared #define seeds once at
 * spawn via workerData and everything else rides inside the task message.
 */
export interface ParseFileTask {
  kind: 'parse';
  /** Absolute path of the .dm file to read, preprocess, lex, and parse. */
  filePath: string;
  /** Path relative to the input dir — the diagnostic `file` stamp. */
  relPath: string;
}

export interface DmiTask {
  kind: 'dmi';
  dmiPath: string;
  rsiPath: string;
}

export interface DmmTask {
  kind: 'dmm';
  dmmPath: string;
  yamlPath: string;
}

export type WorkerTask = ParseFileTask | DmiTask | DmmTask;

/** Result of a ParseFileTask: the file's AST nodes, global var decls, and its
 *  diagnostics exactly as the per-file DiagnosticCollector produced them. */
export interface ParseFileResult {
  nodes: unknown[];
  globalVars: unknown[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

/** Result of a DmiTask/DmmTask: the converter's per-file warning strings. */
export interface WarningsResult {
  warnings: string[];
}

export type WorkerResult = ParseFileResult | WarningsResult;

/** workerData payload sent once at Worker construction. */
export interface WorkerInitData {
  objectDefines?: Map<string, string>;
  functionDefines?: Map<string, FunctionMacro>;
}

/** Wire envelope: main → worker. */
export interface TaskMessage {
  seq: number;
  task: WorkerTask;
}

/** Wire envelope: worker → main. */
export interface ResultMessage {
  seq: number;
  ok: boolean;
  result?: WorkerResult;
  error?: string;
  stack?: string;
}
