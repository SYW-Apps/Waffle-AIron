import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Integration secret resolution (secret_write_registry + resolveSecret)
//
// Secrets (git token, Notion token, diagram signing key) resolve from the
// data-dir store ($WAIRON_DATA_DIR/auth/secrets.json) first, then env. The store
// is written at runtime (`wairon host secret set …`) and read live, so an
// integration can be added to a running server WITHOUT a restart. On a local
// install with no data dir, only the env layer applies.
// ---------------------------------------------------------------------------

const ENV_FALLBACK: Record<string, string[]> = {
  'git-token': ['WAIRON_GIT_TOKEN'],
  'notion-token': ['WAIRON_NOTION_TOKEN'],
  'miro-token': ['WAIRON_MIRO_TOKEN'],
  'signing-secret': ['WAIRON_SIGNING_SECRET', 'WAIRON_ADMIN_TOKEN'],
};

function storePath(): string | null {
  const dataDir = process.env['WAIRON_DATA_DIR'];
  return dataDir ? path.join(dataDir, 'auth', 'secrets.json') : null;
}

function readStore(): Record<string, string> {
  const p = storePath();
  if (!p) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The value under a key in a read store map, else its first env fallback that is set, else null. */
function storedOrEnvironment(store: Record<string, string>, key: string): string | null {
  const stored = store[key];
  if (stored) return stored;
  for (const env of ENV_FALLBACK[key] ?? []) {
    if (process.env[env]) return process.env[env] as string;
  }
  return null;
}

/** Resolve a secret by key: data-dir store, then env fallbacks, else null. */
export function resolveSecret(key: string): string | null {
  return indexResolveSecret(key);
}

/** The index's read behind resolveSecret: one read of the store, then the env fallbacks. */
function indexResolveSecret(key: string): string | null {
  return storedOrEnvironment(readStore(), key);
}

/**
 * Resolve the git token for one connection: its OWN per-connection secret
 * (`credentialRef`) first, then the shared instance-wide `git-token`. This lets
 * each backup binding / project git connection carry a distinct PAT (a different
 * org or account) while a connection without its own PAT still works off the
 * shared token. Returns null when neither is set.
 */
export function resolveGitToken(credentialRef?: string | null): string | null {
  return indexResolveGitToken(credentialRef);
}

/** The index's read behind resolveGitToken: one read of the store, both keys resolved from it. */
function indexResolveGitToken(credentialRef?: string | null): string | null {
  const store = readStore();
  return (credentialRef ? storedOrEnvironment(store, credentialRef) : null) ?? storedOrEnvironment(store, 'git-token');
}

/** Set a secret at runtime in the data-dir store (read live — no restart). */
export function setSecret(key: string, value: string): void {
  registryWriteSecret(key, value);
}

/** The write registry's upsert behind setSecret: read the store, set the key, swap the file atomically. */
function registryWriteSecret(key: string, value: string): void {
  const p = storePath();
  if (!p) throw new Error('WAIRON_DATA_DIR is not set — a running server needs it to store secrets.');
  const store = readStore();
  store[key] = value;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/** List configured secret key names — never the values. */
export function listSecretKeys(): string[] {
  return indexListSecretKeys();
}

/** The index's read behind listSecretKeys: the stored key names, never the values. */
function indexListSecretKeys(): string[] {
  return Object.keys(readStore());
}
