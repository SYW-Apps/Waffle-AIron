import * as path from 'path';
import { files } from '../io/index.js';
import { aiDir } from '../utils/fs.js';
import { parseYaml, serializeYaml } from '../utils/yaml.js';
import type { ReviewRequest } from './reviews.js';

// ---------------------------------------------------------------------------
// Review Store (sdd_core)
//
// The local review handshake between an agent and the human, held in the bound
// project's .wai/.local/ folder (kept out of git by .wai/.gitignore): one YAML
// file per review request under reviews/, and the address a running
// `wairon dev` server announces in dev-server.json. Read from disk on every
// call, so a request written by one process (the MCP server) is seen at once by
// another (the dev server).
// ---------------------------------------------------------------------------

const IGNORE_LINE = '.local/';

function localDir(...segments: string[]): string {
  return aiDir('.local', ...segments);
}

function requestFile(id: string): string {
  return localDir('reviews', `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.yaml`);
}

function announcementFile(): string {
  return localDir('dev-server.json');
}

/** Read a file's text, or null when it is absent or unreadable. */
function readOrNull(file: string): string | null {
  try {
    return files.readText(file);
  } catch {
    return null;
  }
}

/** Parse one stored request; null when it is not one. */
function parseRequest(text: string): ReviewRequest | null {
  try {
    const value = parseYaml(text) as ReviewRequest | null;
    return value && typeof value === 'object' && typeof value.id === 'string' && typeof value.status === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Whether a process is alive (a signal-0 probe; a process we may not signal still counts). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ReviewStore {
  /** Write one request to .wai/.local/reviews/<id>.yaml, with the .wai/.gitignore line that keeps .local/ out of git. */
  save(request: ReviewRequest): void {
    files.ensureDir(localDir('reviews'));
    this.ignoreLocal();
    files.writeText(requestFile(request.id), serializeYaml(request));
  }

  /** One request by id, or null. */
  load(id: string): ReviewRequest | null {
    const text = readOrNull(requestFile(id));
    return text === null ? null : parseRequest(text);
  }

  /** Every request, newest first; an unreadable file is skipped. */
  list(): ReviewRequest[] {
    const dir = localDir('reviews');
    let names: string[];
    try {
      names = files.list(dir);
    } catch {
      return [];
    }
    const found: ReviewRequest[] = [];
    for (const name of names) {
      if (!name.endsWith('.yaml')) continue;
      const text = readOrNull(path.join(dir, name));
      const request = text === null ? null : parseRequest(text);
      if (request) found.push(request);
    }
    return found.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
  }

  /** Record where the dev server serves this project. */
  announceDevServer(url: string, pid: number): void {
    files.ensureDir(localDir());
    this.ignoreLocal();
    files.writeText(announcementFile(), JSON.stringify({ url, pid, at: new Date().toISOString() }, null, 2) + '\n');
  }

  /** Remove the announcement, only when it names this process. */
  withdrawDevServer(pid: number): void {
    const text = readOrNull(announcementFile());
    if (text === null) return;
    try {
      const held = JSON.parse(text) as { pid?: number };
      if (held.pid !== pid) return;
    } catch {
      /* unreadable: nothing of anyone's to protect */
    }
    files.removeFileIfPresent(announcementFile());
  }

  /** The announced dev server's URL while its process is alive, else null. */
  devServer(): string | null {
    const text = readOrNull(announcementFile());
    if (text === null) return null;
    try {
      const held = JSON.parse(text) as { url?: unknown; pid?: unknown };
      return typeof held.url === 'string' && typeof held.pid === 'number' && isAlive(held.pid) ? held.url : null;
    } catch {
      return null;
    }
  }

  /** Make sure .wai/.gitignore holds the `.local/` line, keeping every other line. */
  private ignoreLocal(): void {
    const file = aiDir('.gitignore');
    const held = readOrNull(file);
    if (held !== null && held.split(/\r?\n/).some((l) => l.trim() === IGNORE_LINE)) return;
    const body = held === null
      ? `# Machine-local state (review requests, the dev server's address): never committed.\n${IGNORE_LINE}\n`
      : `${held}${held === '' || held.endsWith('\n') ? '' : '\n'}${IGNORE_LINE}\n`;
    files.writeText(file, body);
  }
}
