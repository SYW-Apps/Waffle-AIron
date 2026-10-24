import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSecretKeys, resolveSecret, setSecret } from '../../src/utils/secrets.js';

// ---------------------------------------------------------------------------
// secret_store.update: one locked read-change-write of the whole map; a corrupt
// file is refused, never replaced by a map of one key; no fixed temporary name.
// ---------------------------------------------------------------------------

let dataDir: string;
let saved: string | undefined;
const file = (): string => path.join(dataDir, 'auth', 'secrets.json');

beforeEach(() => {
  saved = process.env['WAIRON_DATA_DIR'];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-store-'));
  process.env['WAIRON_DATA_DIR'] = dataDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env['WAIRON_DATA_DIR'];
  else process.env['WAIRON_DATA_DIR'] = saved;
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

describe('setSecret', () => {
  it('adds keys to the stored map and leaves no temporary file behind', () => {
    setSecret('git-token', 'one');
    setSecret('notion-token', 'two');
    expect(resolveSecret('git-token')).toBe('one');
    expect(listSecretKeys().sort()).toEqual(['git-token', 'notion-token']);
    expect(fs.readdirSync(path.join(dataDir, 'auth')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a corrupt file instead of replacing it with a map of one key', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{ "git-token": "precious", ');
    expect(() => setSecret('notion-token', 'x')).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file(), 'utf8')).toBe('{ "git-token": "precious", ');
  });

  it('refuses a file that is not a map of secrets', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '["a"]');
    expect(() => setSecret('notion-token', 'x')).toThrow(/not a JSON object/);
    expect(fs.readFileSync(file(), 'utf8')).toBe('["a"]');
  });

  it('throws when the data dir is not set', () => {
    delete process.env['WAIRON_DATA_DIR'];
    expect(() => setSecret('git-token', 'x')).toThrow(/WAIRON_DATA_DIR/);
  });
});
