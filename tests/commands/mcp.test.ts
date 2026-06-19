import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateConfigDir, normalizeBackend } from '../../src/commands/mcp.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-cfgdir-'));
}

describe('normalizeBackend', () => {
  it('maps Claude aliases to claude', () => {
    for (const v of ['claude', 'Claude', 'claude-code', 'CC']) {
      expect(normalizeBackend(v)).toBe('claude');
    }
  });

  it('maps Gemini/Antigravity aliases to gemini', () => {
    for (const v of ['gemini', 'agy', 'Antigravity', 'google', 'gemini-cli']) {
      expect(normalizeBackend(v)).toBe('gemini');
    }
  });

  it('throws on an unknown backend instead of defaulting to claude', () => {
    expect(() => normalizeBackend('codex')).toThrow(/Unknown --backend/);
    expect(() => normalizeBackend('cursor')).toThrow(/Unknown --backend/);
  });
});

describe('validateConfigDir', () => {
  it('accepts a directory with Claude markers', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'settings.json'), '{}');
    expect(() => validateConfigDir(d, 'claude')).not.toThrow();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('accepts an empty directory (treated as fresh)', () => {
    const d = tmp();
    expect(() => validateConfigDir(d, 'claude')).not.toThrow();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('rejects a non-config directory (no agent markers)', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), '{}');
    expect(() => validateConfigDir(d, 'claude')).toThrow(/does not look like a Claude config/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('rejects when the path does not exist and its parent is missing', () => {
    const missing = path.join(os.tmpdir(), 'wairon-no-such-parent-xyz', 'child');
    expect(() => validateConfigDir(missing, 'claude')).toThrow(/parent is missing/);
  });

  it('validates per-agent markers (Gemini)', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'GEMINI.md'), '');
    expect(() => validateConfigDir(d, 'gemini')).not.toThrow();
    // A Claude-only marker should not satisfy the Gemini check.
    const d2 = tmp();
    fs.writeFileSync(path.join(d2, '.credentials.json'), '{}');
    expect(() => validateConfigDir(d2, 'gemini')).toThrow(/does not look like a Gemini/);
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  });
});
