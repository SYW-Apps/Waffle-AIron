import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — a plain .mjs module shared with the demo recorder
import { getKey, mcpKey, canonicalJson } from '../../web/src/demo/canon.mjs';

// The static demo reads a recorded snapshot and refuses every write. The build-time switch is a
// global the bundler replaces; here it is set before the api module is loaded.

const FILES: Record<string, unknown> = {
  'index.json': {
    v: 1,
    demo: { id: 'wairon', title: 't', waironVersion: '1' },
    start: { canvas: 'a', specs: { kind: 'implementation', id: 'x' } },
    gets: { '/web/canvas-model?projectId=local': 'get/model.json' },
    mcp: { [mcpKey('sdd_get_spec', { kind: 'component', id: 'c1' })]: 'spec/c1.json' },
  },
  'get/model.json': { components: [] },
  'spec/c1.json': { id: 'c1' },
};

async function loadDemoApi() {
  vi.resetModules();
  (globalThis as any).__WAIRON_DEMO__ = true;
  const snapshot = await import('../../web/src/demo/snapshot');
  const fetched: string[] = [];
  snapshot.setSnapshotLoader(async (file) => {
    fetched.push(file);
    if (!(file in FILES)) throw new Error('missing ' + file);
    return FILES[file];
  });
  const api = await import('../../web/src/api');
  return { api, snapshot, fetched };
}

describe('demo mode of the API bridge', () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    // No request may reach a server: any real fetch fails the test.
    globalThis.fetch = (() => {
      throw new Error('the demo must not touch the network');
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as any).__WAIRON_DEMO__;
    vi.resetModules();
  });

  it('serves a GET from the recording, with the query in any order', async () => {
    const { api } = await loadDemoApi();
    expect(await api.get('/web/canvas-model?projectId=local')).toEqual({ components: [] });
  });

  it('serves an MCP read from the recording by tool and arguments', async () => {
    const { api } = await loadDemoApi();
    expect(await api.mcpCall('local', 'sdd_get_spec', { id: 'c1', kind: 'component' })).toEqual({ id: 'c1' });
  });

  it('says a request outside the recording is not part of the demo', async () => {
    const { api, snapshot } = await loadDemoApi();
    await expect(api.get('/web/nothing')).rejects.toThrow(snapshot.NOT_IN_DEMO_MESSAGE);
    await expect(api.mcpCall('local', 'sdd_get_spec', { kind: 'component', id: 'zzz' })).rejects.toThrow(snapshot.NOT_IN_DEMO_MESSAGE);
  });

  it('refuses every mutation with the read-only message', async () => {
    const { api, snapshot } = await loadDemoApi();
    await expect(api.post('/web/projects/config', { projectType: 'x' })).rejects.toThrow(snapshot.READ_ONLY_MESSAGE);
    await expect(api.postBinary('/web/packs', new Uint8Array([1]))).rejects.toThrow(snapshot.READ_ONLY_MESSAGE);
    await expect(api.download('/web/export', 'x.zip')).rejects.toThrow(snapshot.READ_ONLY_MESSAGE);
    for (const tool of ['sdd_update_spec', 'sdd_delete_spec', 'sdd_add_component', 'sdd_write_narrative', 'sdd_request_review', 'sdd_rename_method']) {
      await expect(api.mcpCall('local', tool, { kind: 'component', id: 'c1', delta: {} })).rejects.toThrow(snapshot.READ_ONLY_MESSAGE);
    }
  });

  it('answers a probe with not found rather than reaching a server', async () => {
    const { api } = await loadDemoApi();
    expect((await api.raw('/web/dev-login', { redirect: 'manual' })).status).toBe(404);
  });
});

describe('without the demo switch the bridge is the normal one', () => {
  it('does not consult any snapshot', async () => {
    vi.resetModules();
    delete (globalThis as any).__WAIRON_DEMO__;
    const flag = await import('../../web/src/demo/flag');
    expect(flag.DEMO).toBe(false);
  });
});

describe('recorded request keys', () => {
  it('sorts query parameters and object keys', () => {
    expect(getKey('/web/graph?tier=project&projectId=local&level=4')).toBe('/web/graph?level=4&projectId=local&tier=project');
    expect(getKey('/web/context')).toBe('/web/context');
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(mcpKey('sdd_validate_tree', {})).toBe('sdd_validate_tree|{}');
    expect(mcpKey('sdd_get_spec', { id: 'a', kind: 'b' })).toBe(mcpKey('sdd_get_spec', { kind: 'b', id: 'a' }));
  });
});
