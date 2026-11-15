import { describe, it, expect } from 'vitest';
import {
  collectNeedles,
  findLinkageKeys,
  mentionsPath,
  parseToolText,
  redactPaths,
  scrubDeep,
  scrubText,
  selectCanvasModel,
  selectFindings,
  selectGraph,
  specFileName,
  stripLinkage,
  verifyClean,
  // @ts-expect-error — a plain .mjs script with no declarations
} from '../../scripts/demo/lib.mjs';

// The pure steps of the static demo build: stripping, scrubbing, the verification that fails the
// build, and the selection of subsystems.

const ROOTS = ['src', 'tests', 'web'];
const NEEDLES = collectNeedles({
  names: ['Ada Lovelace'],
  emails: ['ada.lovelace@example.com'],
  branches: ['feat/secret-launch', 'origin/fix/hidden-bug', 'origin', 'main', 'origin/HEAD'],
});

describe('stripLinkage', () => {
  it('drops every code-linkage field at any depth, and nothing else', () => {
    const spec = {
      id: 'impl',
      description: 'keeps its prose',
      sourcePath: 'src/a.ts',
      simPath: 'tests/a.test.ts',
      methods: [
        { name: 'run', sourcePath: 'src/b.ts', symbol: 'run', exportedVia: 'index', injectedParams: [{ name: 'ctx' }], narrative: [{ stepNumber: 1, description: 'do' }] },
      ],
      conformance: 'exact',
      nested: { deep: { symbol: 'x', keep: 1 } },
    };
    const out = stripLinkage(spec);
    expect(findLinkageKeys(out)).toEqual([]);
    expect(out).toEqual({
      id: 'impl',
      description: 'keeps its prose',
      methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'do' }] }],
      nested: { deep: { keep: 1 } },
    });
    expect(findLinkageKeys(spec).sort()).toEqual(['conformance', 'exportedVia', 'injectedParams', 'simPath', 'sourcePath', 'symbol']);
  });
});

describe('paths', () => {
  it('finds source and absolute paths, and leaves other prose alone', () => {
    expect(mentionsPath('the function f in "src/server/admin.ts" calls', ROOTS)).toBe(true);
    expect(mentionsPath('see C:\\Users\\someone\\repo\\x', ROOTS)).toBe(true);
    expect(mentionsPath('see /Users/someone/repo/x', ROOTS)).toBe(true);
    expect(mentionsPath('system:\n- the allowed flows', ROOTS)).toBe(false);
    expect(mentionsPath('docs/standards/architecture.md and .wai/specs', ROOTS)).toBe(false);
    expect(mentionsPath('a/src/b is not a root-relative path', ROOTS)).toBe(false);
  });
  it('redacts them in prose', () => {
    expect(redactPaths('one file under src/core/rules/, each', ROOTS)).toBe('one file under \u2026/, each');
  });
});

describe('scrubbing', () => {
  it('replaces emails, people and branch names', () => {
    const s = scrubText('Approved by Ada Lovelace <ada.lovelace@example.com> on feat/secret-launch and origin/fix/hidden-bug, ada.lovelace', NEEDLES);
    expect(s).not.toMatch(/Ada|Lovelace|ada\.lovelace|example\.com|secret-launch|hidden-bug/i);
  });
  it('leaves ordinary prose, short words and common branches alone', () => {
    const text = 'the main origin of a call; dev and ada are words';
    expect(scrubText(text, NEEDLES)).toBe(text);
    expect(NEEDLES.refs).toContain('feat/secret-launch');
    expect(NEEDLES.refs).toContain('fix/hidden-bug');
    expect(NEEDLES.refs).not.toContain('origin');
    expect(NEEDLES.refs).not.toContain('main');
  });
  it('scrubs every string of a value and counts them', () => {
    const r = scrubDeep({ a: ['hi ada.lovelace@example.com', 'fine'], b: { c: 'Ada Lovelace' } }, NEEDLES);
    expect(r.changed).toBe(2);
    expect(JSON.stringify(r.value)).not.toMatch(/ada|lovelace/i);
  });
});

describe('verifyClean fails on what the scrub missed', () => {
  const files = (text: unknown, name = 'data/x.json') => [{ name, text: typeof text === 'string' ? text : JSON.stringify(text) }];
  const check = (f: { name: string; text: string }[]) => verifyClean(f, { needles: NEEDLES, roots: ROOTS });

  it('passes clean data', () => {
    expect(check(files({ description: 'a design, system:\n- one' }))).toEqual([]);
  });
  it('fails on a planted email', () => {
    const hits = check(files({ note: 'mail bob@corp.example please' }));
    expect(hits.map((h: any) => h.kind)).toContain('email');
    expect(hits[0].file).toBe('data/x.json');
  });
  it('fails on a planted name', () => {
    expect(check(files({ approvedBy: 'Ada Lovelace' })).map((h: any) => h.kind)).toContain('person');
  });
  it('fails on a planted branch name, by needle and by shape', () => {
    expect(check(files({ b: 'merged feat/secret-launch' })).map((h: any) => h.kind)).toContain('branch');
    expect(check(files({ b: 'see fix/unknown-thing' })).map((h: any) => h.kind)).toContain('branch');
  });
  it('fails on a planted path and on a surviving linkage field', () => {
    expect(check(files({ m: 'in src/core/x.ts here' })).map((h: any) => h.kind)).toContain('source-path');
    expect(check(files({ m: 'in C:\\work\\repo' })).map((h: any) => h.kind)).toContain('absolute-path');
    expect(check(files({ methods: [{ name: 'a', sourcePath: 'x' }] })).map((h: any) => h.kind)).toContain('linkage-field');
  });
  it('does not mistake an escaped newline for a drive path', () => {
    expect(check(files('{"d":"system:\\n- the allowed flows"}'))).toEqual([]);
  });
});

describe('selection', () => {
  const model = {
    system: { name: 'S' },
    subsystems: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    components: [
      { id: 'a1', subsystem: 'a', owns: [], dependsOn: ['a2', 'b1'], interfaces: [{ id: 'ia1' }] },
      { id: 'a2', subsystem: 'a', owns: [], dependsOn: [], interfaces: [{ id: 'ia2' }] },
      { id: 'b1', subsystem: 'b', owns: [], dependsOn: [], interfaces: [] },
    ],
    edges: [
      { from: 'a1', to: 'a2' },
      { from: 'a1', to: 'b1' },
    ],
    types: [
      { id: 't1', subsystem: 'a', usedBy: [{ component: 'a1' }, { component: 'b1' }] },
      { id: 't2', subsystem: 'b', usedBy: [] },
    ],
    typeEdges: [{ from: 't1', to: 't2' }],
    dataEdges: [],
    issues: [
      { code: 'X', specId: 'a1', message: 'fine' },
      { code: 'X', specId: 'b1', message: 'outside' },
      { code: 'Y', specId: 'a2', message: 'in "src/core/a.ts" the function' },
      { code: 'Z', specId: 'a1_impl', message: 'impl finding' },
    ],
  };

  it('keeps the chosen subsystems, their edges, types and path-free findings', () => {
    const r = selectCanvasModel(model, ['a'], ROOTS, ['a1_impl']);
    expect(r.model.subsystems.map((s: any) => s.id)).toEqual(['a']);
    expect(r.model.components.map((c: any) => c.id)).toEqual(['a1', 'a2']);
    expect(r.model.components[0].dependsOn).toEqual(['a2']);
    expect(r.model.edges).toEqual([{ from: 'a1', to: 'a2' }]);
    expect(r.model.types.map((t: any) => t.id)).toEqual(['t1']);
    expect(r.model.types[0].usedBy).toEqual([{ component: 'a1' }]);
    expect(r.model.typeEdges).toEqual([]);
    expect(r.model.issues.map((i: any) => i.message)).toEqual(['fine', 'impl finding']);
    expect(r.droppedFindings).toBe(2);
  });

  it('limits the spec graph and the validation result alike', () => {
    const graph = {
      nodes: [
        { id: 'S', kind: 'project' },
        { id: 'a', kind: 'subsystem', parentId: 'S' },
        { id: 'b', kind: 'subsystem', parentId: 'S' },
        { id: 'a1', kind: 'component', parentId: 'a' },
        { id: 'b1', kind: 'component', parentId: 'b' },
        { id: 'ia1', kind: 'interface', parentId: 'a1' },
        { id: 'ib1', kind: 'interface', parentId: 'b1' },
        { id: 'a1_impl', kind: 'implementation', parentId: 'a1', noticeCount: 3 },
        { id: 't1', kind: 'type' },
        { id: 't2', kind: 'type' },
      ],
      edges: [
        { from: 'S', to: 'a' },
        { from: 'S', to: 'b' },
      ],
    };
    const g = selectGraph(graph, ['a'], new Set(['t1']));
    expect(g.nodes.map((n: any) => n.id).sort()).toEqual(['S', 'a', 'a1', 'a1_impl', 'ia1', 't1']);
    expect(g.nodes.every((n: any) => !('noticeCount' in n))).toBe(true);
    expect(g.edges).toEqual([{ from: 'S', to: 'a' }]);
    const { result, dropped } = selectFindings(
      { valid: true, errors: [], warnings: [{ specId: 'a1', message: 'ok' }, { specId: 'b1', message: 'no' }], notices: [{ specId: 'a1', message: 'in src/x.ts' }] },
      new Set(['a1']),
      ROOTS,
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.notices).toHaveLength(0);
    expect(dropped).toBe(2);
  });
});

describe('tool replies', () => {
  it('takes pure JSON as it is', () => {
    expect(parseToolText('{"a":1}')).toEqual({ a: 1 });
  });
  it('drops a note trailing the JSON', () => {
    expect(parseToolText('{"a":"}{","b":[1,2]}\n\nNote: this server is stale, reconnect.')).toEqual({ a: '}{', b: [1, 2] });
    expect(parseToolText('[1,{"x":2}] trailing')).toEqual([1, { x: 2 }]);
  });
  it('throws when there is no JSON', () => {
    expect(() => parseToolText('nothing here')).toThrow();
  });
});

describe('file names', () => {
  it('makes a flat safe name per spec', () => {
    expect(specFileName('component', 'a::b/c')).toBe('spec/component__a_b_c.json');
  });
});
