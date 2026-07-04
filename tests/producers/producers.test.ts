import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { project } from '../../src/producers/projection.js';
import { bodyToBlocks, sync } from '../../src/producers/notion.js';
import { resolveSecret, setSecret, listSecretKeys } from '../../src/utils/secrets.js';

// ---------------------------------------------------------------------------
// Unit/integration tests for sdd_producers: the pure spec->DocPage projection,
// the markdown->Notion-blocks conversion, the secret resolver, and the Notion
// client with a mocked API (verifies the calls without a real token).
// ---------------------------------------------------------------------------

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  invalidateSpecCache();
});

describe('spec projection', () => {
  it('projects the spec tree into a wairon-specs DocPage tree', () => {
    invalidateSpecCache();
    // Project this repo's own spec tree — real, stable structure.
    const doc = runWithProjectRoot(process.cwd(), () => project(''));
    expect(doc.title).toBe('wairon specs');
    expect(doc.children.length).toBeGreaterThan(0);
    // Each subsystem page has component children; some component renders methods.
    const componentBodies = doc.children.flatMap((s) => s.children).map((c) => c.body);
    expect(componentBodies.some((b) => b.includes('## Methods'))).toBe(true);
    expect(componentBodies.some((b) => b.includes('**Type:**'))).toBe(true);
  });
});

describe('markdown -> Notion blocks', () => {
  it('converts headings, code fences, and bullets', () => {
    const blocks = bodyToBlocks('# Title\n\nA paragraph.\n## Section\n- one\n```mermaid\nflowchart LR\n```');
    const types = blocks.map((b) => b.type);
    expect(types).toContain('heading_1');
    expect(types).toContain('heading_2');
    expect(types).toContain('paragraph');
    expect(types).toContain('bulleted_list_item');
    const code = blocks.find((b) => b.type === 'code');
    expect(code.code.language).toBe('mermaid');
    expect(code.code.rich_text[0].text.content).toContain('flowchart LR');
  });
});

describe('secret resolver', () => {
  it('resolves data-dir store over env, and lists keys (never values)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-sec-'));
    process.env.WAIRON_DATA_DIR = dataDir;
    process.env.WAIRON_NOTION_TOKEN = 'from-env';

    // env fallback when nothing stored
    expect(resolveSecret('notion-token')).toBe('from-env');

    // stored value wins over env
    setSecret('notion-token', 'from-store');
    expect(resolveSecret('notion-token')).toBe('from-store');
    expect(listSecretKeys()).toContain('notion-token');

    // the store holds the value but list never exposes it
    expect(listSecretKeys()).not.toContain('from-store');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('notion client (mocked API)', () => {
  it('creates the wairon-specs page and its children', async () => {
    process.env.WAIRON_NOTION_TOKEN = 'secret_test';
    const calls: { method: string; path: string; body?: any }[] = [];
    const originalFetch = global.fetch;
    const jsonRes = (obj: any) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = (async (url: string, init: any) => {
      const p = new URL(url).pathname.replace('/v1', '');
      calls.push({ method: init.method, path: p, body: init.body ? JSON.parse(init.body) : undefined });
      if (init.method === 'GET') return jsonRes({ results: [], has_more: false }); // no existing page
      if (init.method === 'POST' && p === '/pages') return jsonRes({ id: `page-${calls.length}` });
      return jsonRes({ ok: true });
    }) as unknown as typeof fetch;

    try {
      await sync(
        { title: 'wairon specs', body: '# Root\n\ntext', children: [{ title: 'Billing', body: '# Billing', children: [] }] },
        'parent-page-id',
      );
      const created = calls.filter((c) => c.method === 'POST' && c.path === '/pages');
      expect(created.length).toBe(2); // root + one child page
      expect(created[0].body.properties.title.title[0].text.content).toBe('wairon specs');
      expect(created[0].body.parent.page_id).toBe('parent-page-id');
      expect(created[1].body.properties.title.title[0].text.content).toBe('Billing');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects when no Notion token is configured', async () => {
    delete process.env.WAIRON_NOTION_TOKEN;
    delete process.env.WAIRON_DATA_DIR;
    await expect(sync({ title: 't', body: '', children: [] }, 'p')).rejects.toThrow(/Notion token/);
  });
});
