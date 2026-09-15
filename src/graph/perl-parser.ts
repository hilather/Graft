/** Lazy, sequential worker client with enforceable startup and per-file bounds. */
import { Worker } from "node:worker_threads";
import { perlFileResult } from "./perl-extract.js";
import type { PerlExtractResult, PerlParseJob, PerlWorkerMessage } from "./perl-types.js";
import { PERL_MAX_SOURCE_CODE_UNITS } from "./perl-types.js";
export { PERL_MAX_SOURCE_CODE_UNITS } from "./perl-types.js";

export const PERL_PARSE_TIMEOUT_MS = 2_000;
export const PERL_STARTUP_TIMEOUT_MS = 5_000;
export const PERL_MAX_RESTARTS = 2;

export interface PerlParserOptions {
  timeoutMs?: number;
  startupTimeoutMs?: number;
  maxRestarts?: number;
  maxPendingJobs?: number;
  assetsDir?: URL;
  /** Internal test seam for real hanging/crashing workers, not a CLI setting. */
  workerFactory?: (assetsDir: URL) => Worker;
}

class PerlWorkerError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class PerlParser {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private started = 0;
  private nextId = 0;
  private closed = false;
  private startup: Promise<void> | null = null;
  private rejectActive: ((reason: Error) => void) | null = null;
  private permanentFailure: PerlWorkerError | null = null;

  constructor(private readonly options: PerlParserOptions = {}) {
    for (const [name, value] of Object.entries(options)) {
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value < (name === "maxRestarts" ? 0 : 1))) throw new Error(`Invalid Perl parser option ${name}`);
    }
  }

  get workerStarts(): number { return this.started; }

  extract(file: string, source: string, mode: "source" | "pod" = "source"): Promise<PerlExtractResult> {
    if (this.closed) return Promise.resolve(this.failure(file, source, "PERL_PARSER_CLOSED", "Perl parser operation is closed"));
    if (source.length > PERL_MAX_SOURCE_CODE_UNITS) return Promise.resolve(this.failure(file, source, "PERL_INPUT_TOO_LARGE", "Perl input exceeds 2,000,000 decoded code units"));
    if (mode === "pod") return Promise.resolve(perlFileResult(file, source));
    if (this.pending >= (this.options.maxPendingJobs ?? 16)) return Promise.resolve(this.failure(file, source, "PERL_QUEUE_FULL", "Perl parser operation has too many pending files"));
    this.pending++;
    const task = this.queue.then(() => this.run({ id: ++this.nextId, file, source, mode }));
    this.queue = task.finally(() => { this.pending--; });
    return task;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await this.queue;
    await this.terminate();
  }

  private failure(file: string, source: string, code: string, message: string): PerlExtractResult {
    return perlFileResult(file, source, [{ code, file, severity: "error", message }], "failed", false);
  }

  private async run(job: PerlParseJob): Promise<PerlExtractResult> {
    try {
      await this.ensureWorker();
      const worker = this.worker!;
      return await new Promise<PerlExtractResult>((resolve, reject) => {
        const done = (error?: Error, result?: PerlExtractResult) => {
          clearTimeout(timer);
          worker.off("message", receive);
          this.rejectActive = null;
          if (error) reject(error); else resolve(result!);
        };
        const receive = (message: PerlWorkerMessage) => {
          if (message.type === "result" && message.id === job.id) done(undefined, message.result);
        };
        const timer = setTimeout(() => done(new PerlWorkerError("PERL_PARSE_TIMEOUT", `Perl parsing exceeded ${this.options.timeoutMs ?? PERL_PARSE_TIMEOUT_MS} ms`)), this.options.timeoutMs ?? PERL_PARSE_TIMEOUT_MS);
        this.rejectActive = (error) => done(error);
        worker.on("message", receive);
        try { worker.postMessage(job); } catch (error) { done(error as Error); }
      });
    } catch (error) {
      await this.terminate();
      return this.failure(job.file, job.source, error instanceof PerlWorkerError ? error.code : "PERL_WORKER_FAILED", (error as Error).message);
    }
  }

  private async ensureWorker(): Promise<void> {
    if (this.permanentFailure) throw this.permanentFailure;
    if (this.worker) return this.startup!;
    if (this.started >= 1 + (this.options.maxRestarts ?? PERL_MAX_RESTARTS)) throw new PerlWorkerError("PERL_RESTART_LIMIT", "Perl worker restart limit reached; remaining files were not analyzed");
    const assetsDir = this.options.assetsDir ?? new URL("./grammars/perl/", import.meta.url);
    // npm ci/build emits the worker before tests. Source execution deliberately
    // uses that compiled entry too, so Node 20 needs no TS loader in the worker.
    const entry = new URL(import.meta.url.endsWith(".ts") ? "../../dist/graph/perl-worker.js" : "./perl-worker.js", import.meta.url);
    const worker = this.options.workerFactory?.(assetsDir) ?? new Worker(entry, { workerData: { assetsDir: assetsDir.href }, execArgv: [] });
    this.worker = worker;
    this.started++;
    this.startup = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new PerlWorkerError("PERL_STARTUP_TIMEOUT", "Perl worker initialization timed out")), this.options.startupTimeoutMs ?? PERL_STARTUP_TIMEOUT_MS);
      const clear = () => { clearTimeout(timer); worker.off("message", ready); this.rejectActive = null; };
      const fail = (error: Error) => { clear(); reject(error); };
      const ready = (message: PerlWorkerMessage) => {
        if (message.type === "ready") { clear(); resolve(); }
        if (message.type === "fatal") {
          this.permanentFailure = new PerlWorkerError(message.code, message.message);
          fail(this.permanentFailure);
        }
      };
      this.rejectActive = fail;
      worker.on("message", ready);
    });
    worker.on("error", (error) => this.rejectActive?.(new PerlWorkerError("PERL_WORKER_FAILED", error instanceof Error ? error.message : String(error))));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.rejectActive?.(new PerlWorkerError("PERL_WORKER_EXIT", `Perl worker exited before completion (${code})`));
      this.worker = null;
      this.startup = null;
    });
    return this.startup;
  }

  private async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.startup = null;
    this.rejectActive = null;
    if (worker) await worker.terminate();
  }
}
