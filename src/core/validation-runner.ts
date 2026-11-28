// ---------------------------------------------------------------------------
// validation_thread + validation_runner (sdd_validator).
//
// The gates take tens of seconds cold. A serving process hands them to ONE
// worker thread instead of running them on its own: the worker loads the
// validator once, keeps its memo warm between jobs, and binds each job's root
// for that job alone. The runner keys every request by root, gate and options
// and lets identical callers share the run in flight.
// ---------------------------------------------------------------------------
import * as path from 'path';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { getProjectRoot, runWithProjectRoot } from '../utils/fs.js';
import * as validationMemo from './validation-memo.js';
import type { ValidationOptions, ValidationResult } from './validation.js';

/** Which remembered gate a background run answers. */
export type ValidationGate = 'owner' | 'as_complete';

/** One gate run handed to the validation thread: plain data only. */
export interface ValidationJob {
  root: string;
  gate: ValidationGate;
  options?: ValidationOptions;
}

interface Waiting {
  resolve: (result: ValidationResult) => void;
  reject: (error: Error) => void;
}

/**
 * The worker entry is this module itself: its own built entry in dist, the TS source under tsx/vitest.
 * None when neither is at hand — a packaged executable built without the worker file, or a source
 * run with no tsx loader beside it — and the caller then runs the job on its own thread.
 */
function workerEntry(): { file: string; execArgv: string[] } | null {
  const base = 'validation-runner';
  const built = [
    path.resolve(__dirname, 'core', `${base}.js`), // dist/index.js
    path.resolve(__dirname, '..', 'core', `${base}.js`), // dist/cli/index.js
    path.resolve(__dirname, `${base}.js`),
  ].find((p) => existsSync(p));
  if (built) return { file: built, execArgv: [] };
  // Source run (tsx, vitest): the loader is found from this file, not the process cwd.
  const source = path.resolve(__dirname, `${base}.ts`);
  const loader = path.resolve(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');
  if (!existsSync(source) || !existsSync(loader)) return null;
  return { file: source, execArgv: ['--import', pathToFileURL(loader).href] };
}

/** Test seam: pretend the worker's entry is missing, as in a packaged executable built without it. */
let entryMissing = false;
export function simulateMissingWorkerEntry(missing: boolean): void {
  entryMissing = missing;
}

/** One job answered on the calling thread, bound to the job's root. */
function runHere(job: ValidationJob): Promise<ValidationResult> {
  return runWithProjectRoot(job.root, () =>
    Promise.resolve(job.gate === 'owner' ? validationMemo.validateProject(job.options) : validationMemo.validateAsComplete(job.options)));
}

/** Whether this code runs inside the worker the thread started. */
function onValidationThread(): boolean {
  return !isMainThread && (workerData as { validationThread?: boolean } | null)?.validationThread === true;
}

// ---------------------------------------------------------------------------
// validation_thread
// ---------------------------------------------------------------------------
let worker: Worker | null = null;
let nextJob = 1;
const waiting = new Map<number, Waiting>();

function settleAll(error: Error): void {
  const all = [...waiting.values()];
  waiting.clear();
  for (const w of all) w.reject(error);
}

/** Keep the process alive only while a job waits. */
function syncRef(w: Worker): void {
  if (waiting.size > 0) w.ref();
  else w.unref();
}

function startWorker(entry: { file: string; execArgv: string[] }): Worker {
  const { file, execArgv } = entry;
  const w = new Worker(file, { execArgv, workerData: { validationThread: true } });
  w.on('message', (msg: { id: number; result?: ValidationResult; error?: string }) => {
    const job = waiting.get(msg.id);
    if (!job) return;
    waiting.delete(msg.id);
    if (msg.error !== undefined) job.reject(new Error(msg.error));
    else job.resolve(msg.result as ValidationResult);
    syncRef(w);
  });
  const lost = (error: Error): void => {
    if (worker === w) worker = null;
    settleAll(error);
  };
  w.on('error', (e) => lost(e instanceof Error ? e : new Error(String(e))));
  w.on('exit', (code) => lost(new Error(`the validation thread exited (code ${code})`)));
  w.unref();
  return w;
}

/** validation_thread.run — one job on the worker thread, after the jobs before it. */
export function runOnThread(job: ValidationJob): Promise<ValidationResult> {
  // On the thread itself: the job's root bound for this run alone, the gate answered through the memo.
  if (onValidationThread()) return runHere(job);
  // Steps 1 and 11-15: no entry to start the thread from — the job runs here instead of failing.
  const entry = worker ? null : entryMissing ? null : workerEntry();
  if (!worker && !entry) return runHere(job);
  const w = worker ?? (worker = startWorker(entry as { file: string; execArgv: string[] }));
  const id = nextJob++;
  return new Promise<ValidationResult>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.ref();
    w.postMessage({ id, job });
  });
}

/** validation_thread.stop — terminate the thread, failing every job still waiting. */
export async function stopThread(): Promise<void> {
  const w = worker;
  worker = null;
  settleAll(new Error('the validation thread was stopped'));
  if (w) await w.terminate();
}

// ---------------------------------------------------------------------------
// validation_runner
// ---------------------------------------------------------------------------
const inFlight = new Map<string, Promise<ValidationResult>>();

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v);
}

/** validation_runner.run — the gate for the bound project from the validation thread. */
export function run(gate: ValidationGate, options?: ValidationOptions): Promise<ValidationResult> {
  if (options?.extensions) {
    return Promise.reject(new Error('options with loaded extensions cannot run off the thread'));
  }
  const root = path.resolve(getProjectRoot());
  const key = `${root}\u0000${gate}\u0000${stable(options ?? null)}`;
  const shared = inFlight.get(key);
  if (shared) return shared;
  const started = runOnThread({ root, gate, ...(options ? { options } : {}) });
  const held = started.finally(() => {
    if (inFlight.get(key) === held) inFlight.delete(key);
  });
  inFlight.set(key, held);
  return held;
}

/** validation_runner.stop — stop the validation thread. */
export async function stop(): Promise<void> {
  await stopThread();
}

// ---------------------------------------------------------------------------
// The thread's side: per job, bind the job's root and answer the gate through
// the validation memo. Runs only inside the worker this module starts.
// ---------------------------------------------------------------------------
if (onValidationThread() && parentPort) {
  const port = parentPort;
  port.on('message', (msg: { id: number; job: ValidationJob }) => {
    runOnThread(msg.job).then(
      (result) => port.postMessage({ id: msg.id, result }),
      (e: unknown) => port.postMessage({ id: msg.id, error: e instanceof Error ? e.message : String(e) }),
    );
  });
}
