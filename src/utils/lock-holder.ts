import * as fs from 'fs';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Who a file lock names as its holder (the lock_holder type)
//
// A process id means something only inside one PID namespace, and the same
// host name does not prove a shared one (containers started with one hostname,
// a data directory bind-mounted into a container and also used from the host).
// The record therefore carries the namespace, and "local" is host AND namespace.
// ---------------------------------------------------------------------------

/** lock_holder: pid, time taken, machine and PID namespace of the process holding a lock. */
export interface LockHolder {
  /** The holder's process id, meaningful only inside its PID namespace. */
  pid: number;
  /** Milliseconds since the epoch at which the lock was taken. */
  takenAt: number;
  /** The machine name the lock was taken on; absent in a record an older wairon wrote. */
  host?: string;
  /** The PID namespace identity (Linux: the target of /proc/self/ns/pid); absent where there is none or it cannot be read. */
  pidNamespace?: string;
}

const NAMESPACE_PREFIX = 'pidns=';

let ownNamespace: string | null | undefined;

/** This process's PID namespace: the target of /proc/self/ns/pid on Linux when readable, otherwise absent. */
export function ownPidNamespace(): string | undefined {
  if (ownNamespace === undefined) {
    try {
      ownNamespace = process.platform === 'linux' ? fs.readlinkSync('/proc/self/ns/pid') : null;
    } catch {
      ownNamespace = null;
    }
  }
  return ownNamespace ?? undefined;
}

/** The holder identity of this process, taken now. */
export function currentHolder(now: number = Date.now()): LockHolder {
  const pidNamespace = ownPidNamespace();
  return { pid: process.pid, takenAt: now, host: os.hostname(), ...(pidNamespace !== undefined ? { pidNamespace } : {}) };
}

/**
 * lock_holder.isLocalTo — whether `holder` runs where `here` does, so its pid
 * can be checked for liveness: the host names are equal (an absent host counts
 * as equal) AND the namespaces are equal (the same identity, or both absent).
 * A namespace on one side only is unequal: a Linux process judging a record
 * without one treats the holder as remote.
 */
export function holderIsLocal(holder: LockHolder, here: LockHolder): boolean {
  const sameHost = holder.host === undefined || here.host === undefined || holder.host === here.host;
  return sameHost && holder.pidNamespace === here.pidNamespace;
}

/** Whether a process of that id is alive here: only "no such process" means gone; any other refusal leaves it unknown, so alive. A pid that is not positive names none. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The text of a lock file: pid, time, host, a nonce (one line each) and, when
 * the namespace is known, a trailing `pidns=<id>` line, so an older reader
 * ignores it and no positional line moves.
 */
export function serializeHolder(holder: LockHolder, nonce: string): string {
  const base = `${holder.pid}\n${holder.takenAt}\n${holder.host ?? ''}\n${nonce}\n`;
  return holder.pidNamespace !== undefined ? `${base}${NAMESPACE_PREFIX}${holder.pidNamespace}\n` : base;
}

/** The holder a lock file's text names, or null when it names none (empty, foreign or truncated). */
export function parseHolder(text: string): LockHolder | null {
  const lines = text.split(/\r?\n/);
  if (!/^\d+$/.test(lines[0] ?? '') || !/^\d+$/.test(lines[1] ?? '')) return null;
  const host = lines[2];
  const ns = lines.slice(3).find((l) => l.startsWith(NAMESPACE_PREFIX));
  return {
    pid: Number(lines[0]),
    takenAt: Number(lines[1]),
    ...(host ? { host } : {}),
    ...(ns !== undefined && ns.length > NAMESPACE_PREFIX.length ? { pidNamespace: ns.slice(NAMESPACE_PREFIX.length) } : {}),
  };
}
