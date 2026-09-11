import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { aiPathsAt } from '../config/loader.js';

// ---------------------------------------------------------------------------
// Remote Binding Store (remote_binding_store_impl)
//
// The durable half of `wairon remote attach`, deliberately split across TWO
// files with different lifetimes and different trust:
//
//   <project>/.wai/remote.json     the BINDING (instance URL + project id).
//                                  Not a secret; a team may commit it so every
//                                  checkout attaches to the same instance.
//   ~/.wairon/credentials.json     the CREDENTIALS, keyed by instance URL.
//                                  Never written into a project directory.
//
// Every read goes to disk (no RAM copy to go stale when another process
// re-attaches or a token is rotated) and treats a missing or malformed file as
// "nothing stored" — an unattached checkout is a normal state, not an error.
// ---------------------------------------------------------------------------

/** A checkout's standing attachment to one hosted project (never a credential). */
export interface RemoteBinding {
  url: string;
  projectId: string;
  /** Where the binding was resolved from: 'flags' | 'binding-file' | 'mcp-config'. */
  source: string;
  attachedAt?: string;
}

const BINDING_FILE = 'remote.json';
const CREDENTIALS_FILE = 'credentials.json';

/** The binding file for a project root. */
function bindingPath(root: string): string {
  return path.join(aiPathsAt(root).root(), BINDING_FILE);
}

/** The user's credential store path (never inside a project). */
function credentialsPath(): string {
  return path.join(os.homedir(), '.wairon', CREDENTIALS_FILE);
}

/**
 * Canonical key for an instance URL, so a trailing slash or differing case can
 * never hide a stored credential from the command that needs it.
 */
export function normalizeInstanceUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

function readJson<T>(file: string): T | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null; // absent, unreadable, or malformed — all "nothing stored"
  }
}

/** Write atomically (temp + rename) so a concurrent read never sees a half file. */
function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode !== undefined ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode !== undefined) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      /* platforms without POSIX modes (Windows) — the rename already landed */
    }
  }
}

/** The binding recorded for a project root, or null when unattached. */
export function readBinding(root: string): RemoteBinding | null {
  const record = readJson<{ url?: unknown; projectId?: unknown; attachedAt?: unknown }>(bindingPath(root));
  if (!record || typeof record.url !== 'string' || typeof record.projectId !== 'string') return null;
  if (!record.url || !record.projectId) return null;
  const binding: RemoteBinding = { url: record.url, projectId: record.projectId, source: 'binding-file' };
  if (typeof record.attachedAt === 'string') binding.attachedAt = record.attachedAt;
  return binding;
}

/** Record the binding for a project root — URL and project only, never a token. */
export function writeBinding(root: string, binding: RemoteBinding): void {
  writeJsonAtomic(bindingPath(root), {
    url: binding.url,
    projectId: binding.projectId,
    attachedAt: binding.attachedAt ?? new Date().toISOString(),
  });
}

/** Detach a project root (idempotent). */
export function clearBinding(root: string): void {
  try {
    fs.rmSync(bindingPath(root), { force: true });
  } catch {
    /* already gone */
  }
}

/** The stored credential for an instance URL, or null. */
export function readCredential(url: string): string | null {
  const store = readJson<Record<string, string>>(credentialsPath());
  const token = store?.[normalizeInstanceUrl(url)];
  return typeof token === 'string' && token ? token : null;
}

/** Store the credential for an instance URL in the USER's credential store. */
export function writeCredential(url: string, token: string): void {
  const store = readJson<Record<string, string>>(credentialsPath()) ?? {};
  store[normalizeInstanceUrl(url)] = token;
  // 0600: this file holds live bearer credentials.
  writeJsonAtomic(credentialsPath(), store, 0o600);
}

/**
 * Forget the credential for an instance LOCALLY. This does not — and cannot —
 * revoke it on the instance; callers must say so plainly.
 */
export function clearCredential(url: string): void {
  const store = readJson<Record<string, string>>(credentialsPath());
  if (!store) return;
  delete store[normalizeInstanceUrl(url)];
  writeJsonAtomic(credentialsPath(), store, 0o600);
}

/** The instance URLs a credential is stored for — URLs only, never tokens. */
export function listCredentialUrls(): string[] {
  const store = readJson<Record<string, string>>(credentialsPath());
  return store ? Object.keys(store).sort() : [];
}
