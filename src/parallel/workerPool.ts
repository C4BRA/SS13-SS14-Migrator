import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import type { ResultMessage, WorkerInitData, WorkerResult, WorkerTask } from './workerProtocol.js';

interface QueuedTask {
  task: WorkerTask;
  resolve: (result: WorkerResult) => void;
  reject: (err: Error) => void;
}

interface Inflight {
  seq: number;
  resolve: (result: WorkerResult) => void;
  reject: (err: Error) => void;
}

/**
 * Fixed-size pool of node:worker_threads running dist/parallel/parseWorker.js.
 * One task per worker at a time; results carry the submitter's sequence number
 * so callers always merge in task order, never completion order.
 *
 * The pool is shared across pipeline stages: workers are spawned once with the
 * global #define seeds in workerData and then run parse, DMI, and DMM tasks.
 */
export class ConversionWorkerPool {
  private workers = new Set<Worker>();
  private idle: Worker[] = [];
  private queue: QueuedTask[] = [];
  private inflight = new Map<Worker, Inflight>();
  private seq = 0;
  private closed = false;

  constructor(size: number, initData?: WorkerInitData) {
    const workerFile = path.join(__dirname, 'parseWorker.js');
    for (let i = 0; i < Math.max(1, size); i++) {
      const w = new Worker(workerFile, { workerData: initData });
      w.on('message', (msg: ResultMessage) => this.onMessage(w, msg));
      w.on('error', (err: Error) => this.killWorker(w, err));
      w.on('exit', (code: number) => {
        if (code !== 0) this.killWorker(w, new Error(`conversion worker exited with code ${code}`));
      });
      this.workers.add(w);
      this.idle.push(w);
    }
  }

  public exec<T extends WorkerResult>(task: WorkerTask): Promise<T> {
    if (this.closed) return Promise.reject(new Error('worker pool is closed'));
    return new Promise<WorkerResult>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.dispatch();
    }) as Promise<T>;
  }

  private dispatch(): void {
    while (!this.closed && this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.shift()!;
      const { task, resolve, reject } = this.queue.shift()!;
      const seq = ++this.seq;
      this.inflight.set(w, { seq, resolve, reject });
      try {
        w.postMessage({ seq, task });
      } catch (err: any) {
        this.inflight.delete(w);
        this.killWorker(w, err instanceof Error ? err : new Error(String(err)));
        reject(err);
      }
    }
  }

  private onMessage(w: Worker, msg: ResultMessage): void {
    const pending = this.inflight.get(w);
    if (!pending || pending.seq !== msg.seq) return;
    this.inflight.delete(w);
    if (!this.closed) {
      this.idle.push(w);
      this.dispatch();
    }
    if (msg.ok) {
      pending.resolve(msg.result as WorkerResult);
    } else {
      const err = new Error(msg.error ?? 'conversion worker task failed');
      if (msg.stack) err.stack = msg.stack;
      pending.reject(err);
    }
  }

  private killWorker(w: Worker, err: Error): void {
    const pending = this.inflight.get(w);
    if (pending) {
      this.inflight.delete(w);
      pending.reject(err);
    }
    const idleIdx = this.idle.indexOf(w);
    if (idleIdx >= 0) this.idle.splice(idleIdx, 1);
    if (this.workers.delete(w)) {
      w.terminate().catch(() => {});
    }
    if (!this.closed && this.workers.size === 0) {
      const drained = this.queue.splice(0);
      for (const q of drained) q.reject(err);
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const drained = this.queue.splice(0);
    const err = new Error('worker pool closed');
    for (const q of drained) q.reject(err);
    for (const pending of this.inflight.values()) pending.reject(err);
    this.inflight.clear();
    this.idle.length = 0;
    const exits = [...this.workers].map(w => w.terminate());
    this.workers.clear();
    await Promise.allSettled(exits);
  }
}
