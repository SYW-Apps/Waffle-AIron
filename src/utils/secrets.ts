import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Integration secret resolution (secret_registry + resolveSecret)
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

/** Resolve a secret by key: data-dir store, then env fallbacks, else null. */
export function resolveSecret(key: string): string | null {
  const stored = readStore()[key];
  if (stored) return stored;
  for (const env of ENV_FALLBACK[key] ?? []) {
    if (process.env[env]) return process.env[env] as string;
  }
  return null;
}

/** Set a secret at runtime in the data-dir store (read live — no restart). */
export function setSecret(key: string, value: string): void {
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
  return Object.keys(readStore());
}
