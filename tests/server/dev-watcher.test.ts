import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { watch, watchProducers, DEV_WATCH_DEBOUNCE_MS } from '../../src/server/dev-watcher.js';
import type { DevChangeKind, DevProducer } from '../../src/server/dev-watcher.js';

// ---------------------------------------------------------------------------
// dev_tree_watcher: one recursive watch on the served project's .wai/ folder,
// coalesced over a quarter of a second; review requests are `reviews`, anything
// else `tree`, and lock files are not changes.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('dev tree watcher (sdd_host)', () => {
  let root: string;
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  function project(): void {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-devwatch-'));
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(root, '.wai', '.local', 'reviews'), { recursive: true });
  }

  async function settle(): Promise<void> {
    await sleep(DEV_WATCH_DEBOUNCE_MS + 400);
  }

  it('says `tree` once for a burst of spec writes', async () => {
    project();
    const seen: DevChangeKind[] = [];
    stop = watch(root, (k) => seen.push(k));
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'a.yaml'), 'a: 1');
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'b.yaml'), 'b: 1');
    fs.writeFileSync(path.join(root, '.wai', 'lock.json'), '{}');
    await settle();
    expect(seen).toEqual(['tree']);
  });

  it('says `reviews` for a review request, and `tree` too when the tree changed alongside', async () => {
    project();
    const seen: DevChangeKind[] = [];
    stop = watch(root, (k) => seen.push(k));
    fs.writeFileSync(path.join(root, '.wai', '.local', 'reviews', 'r1.yaml'), 'id: r1');
    await settle();
    expect(seen).toEqual(['reviews']);

    seen.length = 0;
    fs.writeFileSync(path.join(root, '.wai', '.local', 'reviews', 'r2.yaml'), 'id: r2');
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'c.yaml'), 'c: 1');
    await settle();
    expect([...seen].sort()).toEqual(['reviews', 'tree']);
  });

  it('ignores the spec tree write lock and other lock files', async () => {
    project();
    const seen: DevChangeKind[] = [];
    stop = watch(root, (k) => seen.push(k));
    fs.mkdirSync(path.join(root, '.wai', '.spec-write.lock'));
    fs.writeFileSync(path.join(root, '.wai', '.spec-write.lock', 'owner'), 'pid');
    fs.writeFileSync(path.join(root, '.wai', 'other.lock'), 'x');
    await settle();
    expect(seen).toEqual([]);
  });

  it('says `tree` when git HEAD is rewritten (a branch switch), and stops watching it on stop', async () => {
    project();
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/a');
    const seen: DevChangeKind[] = [];
    const stopIt = watch(root, (k) => seen.push(k));
    fs.writeFileSync(path.join(root, '.git', 'index'), 'x');
    await settle();
    expect(seen).toEqual([]);
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/b');
    await settle();
    expect(seen).toEqual(['tree']);
    stopIt();
    seen.length = 0;
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/c');
    await settle();
    expect(seen).toEqual([]);
    stop = undefined;
  });

  it('says nothing after it is stopped, and stopping twice is harmless', async () => {
    project();
    const seen: DevChangeKind[] = [];
    const stopIt = watch(root, (k) => seen.push(k));
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'a.yaml'), 'a: 1');
    stopIt();
    stopIt();
    await settle();
    expect(seen).toEqual([]);
    stop = undefined;
  });

  it('answers a stop function that does nothing for a folder with no .wai/', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-devwatch-'));
    const stopIt = watch(root, () => undefined);
    expect(() => stopIt()).not.toThrow();
  });
});

describe('dev producer watcher (sdd_host)', () => {
  const roots: string[] = [];
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    for (const r of roots.splice(0)) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* windows file locks */ }
    }
  });

  function producer(alias: string, relation: DevProducer['relation']): DevProducer {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-devprod-'));
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    roots.push(root);
    return { alias, root, relation };
  }

  it('names the producer that changed, once per burst, and ignores lock files', async () => {
    const member = producer('part', 'member');
    const external = producer('geo', 'external');
    const seen: string[] = [];
    stop = watchProducers([member, external], (p) => seen.push(`${p.relation}:${p.alias}`));
    fs.writeFileSync(path.join(external.root, '.wai', 'specs', 'a.yaml'), 'a: 1');
    fs.writeFileSync(path.join(external.root, '.wai', 'specs', 'b.yaml'), 'b: 1');
    fs.writeFileSync(path.join(member.root, '.wai', 'other.lock'), 'x');
    await sleep(DEV_WATCH_DEBOUNCE_MS + 400);
    expect(seen).toEqual(['external:geo']);
  });

  it('skips a producer whose folder cannot be watched, and stops every watch', async () => {
    const member = producer('part', 'member');
    const gone: DevProducer = { alias: 'gone', root: path.join(member.root, 'missing'), relation: 'member' };
    const seen: string[] = [];
    const stopAll = watchProducers([gone, member], (p) => seen.push(p.alias));
    stopAll();
    fs.writeFileSync(path.join(member.root, '.wai', 'specs', 'a.yaml'), 'a: 1');
    await sleep(DEV_WATCH_DEBOUNCE_MS + 400);
    expect(seen).toEqual([]);
    expect(() => stopAll()).not.toThrow();
  });
});
