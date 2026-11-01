import { execFileSync, execSync, spawn } from 'child_process';
import type { StdioOptions } from 'child_process';

// ---------------------------------------------------------------------------
// io/process — child processes, one call per outside action
//
// wairon's one place to run another program. `run` is a program and its
// arguments (no shell); `runShell` is a command line a shell reads, for the
// few places that need one; `start` launches a program and leaves it running.
// Behaviour is exactly the child_process call each wraps, so a library or
// runtime change is made here once.
// ---------------------------------------------------------------------------

/** What a call to run or runShell takes; the names are child_process's, passed through. */
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  stdio?: StdioOptions;
  windowsHide?: boolean;
}

/** Run a program with arguments and answer its standard output as UTF-8 text. Throws as execFileSync does (a non-zero exit, a timeout, a missing program). */
export function run(command: string, args: readonly string[], options: RunOptions = {}): string {
  return execFileSync(command, args, { ...options, encoding: 'utf8' });
}

/** Run a command line through the shell and answer its standard output as UTF-8 text. Throws as execSync does. */
export function runShell(commandLine: string, options: RunOptions = {}): string {
  return execSync(commandLine, { ...options, encoding: 'utf8' });
}

/** Start a program detached with its streams ignored and leave it running (opening a browser). A program that cannot be started is not an error here: it is fire-and-forget. */
export function start(command: string, args: readonly string[]): void {
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    /* the program is not there — nothing to wait for */
  });
  child.unref();
}
