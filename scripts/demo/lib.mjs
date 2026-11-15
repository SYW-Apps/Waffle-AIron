// The pure steps of the static demo build (scripts/demo/build-demo.mjs): choosing what the demo
// holds, stripping code linkage, scrubbing people and branches, and the verification that fails
// the build when anything private is left. No I/O lives here, so every rule is unit tested.

/** Fields that say where a design is realized in code. They are dropped everywhere. */
export const LINKAGE_KEYS = new Set([
  'sourcePath',
  'symbol',
  'exportedVia',
  'simPath',
  'injectedParams',
  'conformance',
  'conformanceTier',
  'conformanceTiers',
  'conformanceGrade',
  'conformanceDial',
  'sourceFiles',
  'symbolMap',
  'resolvedSignatures',
  'projectPath',
  // Links out of the page (a framed demo has no popups); a link is dropped, not shown as text.
  'externalLinks',
]);

/** A value dropped by the strip, never a placeholder: the key disappears. */
export function stripLinkage(value, extraKeys = []) {
  const drop = new Set([...LINKAGE_KEYS, ...extraKeys]);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (!drop.has(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** The linkage keys still present anywhere in a value (for the verification pass). */
export function findLinkageKeys(value, extraKeys = []) {
  const drop = new Set([...LINKAGE_KEYS, ...extraKeys]);
  const hits = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (drop.has(k)) hits.add(k);
        walk(x);
      }
    }
  };
  walk(value);
  return [...hits];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern of a repository-relative source path: one of the project's code folders, then a path. */
export function repoPathPattern(roots) {
  if (roots.length === 0) return null;
  return new RegExp('(?<![\\w./-])(?:' + roots.map(escapeRe).join('|') + ')/[\\w@./+-]*[\\w]', 'g');
}

/** Absolute paths of this machine: a Windows drive path, or a path under a home folder. */
const ABSOLUTE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]*|\/(?:Users|home|root)\/[^\s"'<>|]*/g;

/** Whether a string names a source file or an absolute path (a finding that does is dropped). */
export function mentionsPath(text, roots) {
  ABSOLUTE_PATH.lastIndex = 0;
  if (ABSOLUTE_PATH.test(text)) return true;
  const re = repoPathPattern(roots);
  if (!re) return false;
  re.lastIndex = 0;
  return re.test(text);
}

/** Replace repo-relative and absolute paths inside a string with an ellipsis. */
export function redactPaths(text, roots) {
  let out = text.replace(ABSOLUTE_PATH, '…');
  const re = repoPathPattern(roots);
  if (re) out = out.replace(re, '…');
  return out;
}

/** redactPaths on every string of a value; returns the new value and how many strings changed. */
export function redactPathsDeep(value, roots, onChange = () => {}) {
  let changed = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redactPaths(v, roots);
      if (r !== v) {
        changed++;
        onChange(v, r);
      }
      return r;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value), changed };
}

// ---------------------------------------------------------------------------------------------
// Scrubbing: people and branches

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** Branch-shaped refs: a conventional prefix, a slash and a name. */
const BRANCH_REF = /\b(?:feat|feature|fix|bugfix|hotfix|chore|refactor|dependabot|renovate)\/[\w./-]*[\w]/g;
/** Branch names too common as words to be told from prose; only the prefixed refs above stand for them. */
const COMMON_BRANCHES = new Set(['main', 'master', 'dev', 'develop', 'development', 'head', 'trunk']);
/** A branch name worth hunting for: it has a separator (a one-word name reads as prose) and is not a common one. */
const isBranchNeedle = (name) => name.length >= 3 && /[/_.-]/.test(name) && !COMMON_BRANCHES.has(name.toLowerCase()) && !/[\s>]/.test(name);

/**
 * What the build must not leak: the maintainer's names and emails (git config, the lock's
 * approver, commit authors) and the repository's branch names. Each needle is matched whole,
 * case-insensitively. Short or common tokens are not needles: they would match ordinary prose.
 */
export function collectNeedles({ names = [], emails = [], branches = [] }) {
  const people = new Set();
  const add = (s) => {
    const t = String(s ?? '').trim();
    if (t.length >= 4) people.add(t);
  };
  for (const n of names) {
    add(n);
    for (const part of String(n).split(/[\s._-]+/)) add(part);
  }
  for (const e of emails) {
    add(e);
    const local = String(e).split('@')[0];
    add(local);
    for (const part of local.split(/[._+-]+/)) add(part);
  }
  const refs = new Set();
  for (const b of branches) {
    const name = String(b).trim().replace(/^remotes\//, '').replace(/^origin\//, '').replace(/^\* /, '');
    if (isBranchNeedle(name)) refs.add(name);
  }
  return { people: [...people], refs: [...refs] };
}

const needleRe = (list) => (list.length === 0 ? null : new RegExp('(?<![\\w])(?:' + list.map(escapeRe).sort((a, b) => b.length - a.length).join('|') + ')(?![\\w])', 'gi'));

/** Scrub one string: emails, branch refs, then the named people and branches. */
export function scrubText(text, needles) {
  let out = text.replace(EMAIL, 'maintainer@example.invalid').replace(BRANCH_REF, 'a-branch');
  const refRe = needleRe(needles.refs);
  if (refRe) out = out.replace(refRe, 'a-branch');
  const peopleRe = needleRe(needles.people);
  if (peopleRe) out = out.replace(peopleRe, 'the maintainer');
  return out;
}

/** scrubText on every string of a value; returns the new value and how many strings changed. */
export function scrubDeep(value, needles, onChange = () => {}) {
  let changed = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = scrubText(v, needles);
      if (r !== v) {
        changed++;
        onChange(v, r);
      }
      return r;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value), changed };
}

/** Every string a JSON value holds: its string values and its keys. */
function jsonStrings(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        walk(x);
      }
    }
  };
  walk(value);
  return out;
}

/**
 * The verification pass: every output file's text, searched for what must not be there. Returns
 * the hits (empty when clean); the build exits non-zero on any, naming the file and the match.
 * `files` is [{ name, text }].
 */
export function verifyClean(files, { needles, roots, extraLinkageKeys = [] }) {
  const hits = [];
  const refRe = needleRe(needles.refs);
  const peopleRe = needleRe(needles.people);
  const pathRe = repoPathPattern(roots);
  for (const { name, text: raw } of files) {
    const note = (kind, match) => hits.push({ file: name, kind, match: String(match).slice(0, 80) });
    // JSON is searched as the strings it holds (an escaped newline is not a path separator).
    let text = raw;
    if (name.endsWith('.json')) {
      try {
        text = jsonStrings(JSON.parse(raw)).join('\n');
      } catch {
        note('invalid-json', name);
        continue;
      }
    }
    for (const m of text.matchAll(EMAIL)) note('email', m[0]);
    for (const m of text.matchAll(BRANCH_REF)) note('branch', m[0]);
    if (refRe) for (const m of text.matchAll(refRe)) note('branch', m[0]);
    if (peopleRe) for (const m of text.matchAll(peopleRe)) note('person', m[0]);
    for (const m of text.matchAll(ABSOLUTE_PATH)) note('absolute-path', m[0]);
    if (pathRe) for (const m of text.matchAll(pathRe)) note('source-path', m[0]);
    if (name.endsWith('.json')) {
      for (const k of findLinkageKeys(JSON.parse(raw), extraLinkageKeys)) note('linkage-field', k);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Selection

/**
 * What a selection of subsystems keeps of the canvas model: those subsystems, their components
 * and the edges between them, their types, and the findings that concern them and name no path.
 * `extraIds` are further spec ids that count as kept (implementations, which the model does not
 * list). Returns the kept model, the kept spec ids and what was dropped.
 */
export function selectCanvasModel(model, selection, roots, extraIds = []) {
  const subs = new Set(selection);
  const inSel = (s) => subs.has(s);
  const components = model.components.filter((c) => inSel(c.subsystem));
  const compIds = new Set(components.map((c) => c.id));
  const keepComp = (id) => compIds.has(id);
  const types = model.types.filter((t) => inSel(t.subsystem));
  const typeIds = new Set(types.map((t) => t.id));
  const interfaceIds = new Set();
  for (const c of components) for (const i of c.interfaces ?? []) interfaceIds.add(i.id);
  const implIds = new Set();
  for (const c of components) for (const i of c.implementations ?? []) implIds.add(i.id);
  const subsystems = model.subsystems.filter((s) => subs.has(s.id));
  const specIds = new Set([...subs, ...compIds, ...typeIds, ...interfaceIds, ...implIds, ...extraIds]);

  const keptComponents = components.map((c) => ({
    ...c,
    owns: (c.owns ?? []).filter(keepComp),
    dependsOn: (c.dependsOn ?? []).filter(keepComp),
  }));
  const keptTypes = types.map((t) => ({ ...t, usedBy: (t.usedBy ?? []).filter((u) => keepComp(u.component)) }));
  const droppedFindings = { count: 0 };
  const issues = (model.issues ?? []).filter((i) => {
    const keep = (i.specId === undefined || specIds.has(i.specId)) && !mentionsPath(JSON.stringify(i), roots);
    if (!keep) droppedFindings.count++;
    return keep;
  });
  return {
    model: {
      ...model,
      subsystems,
      components: keptComponents,
      edges: (model.edges ?? []).filter((e) => keepComp(e.from) && keepComp(e.to)),
      types: keptTypes,
      typeEdges: (model.typeEdges ?? []).filter((e) => typeIds.has(e.from) && typeIds.has(e.to)),
      dataEdges: (model.dataEdges ?? []).filter((e) => keepComp(e.from) && keepComp(e.to)),
      issues,
    },
    specIds,
    droppedFindings: droppedFindings.count,
    components: [...compIds],
    types: [...typeIds],
  };
}

/** The same selection applied to the spec graph the Specs picker reads. */
export function selectGraph(graph, selection, typeIds) {
  const subs = new Set(selection);
  const keep = new Map();
  for (const n of graph.nodes) {
    if (n.kind === 'project') keep.set(n.id, n);
    else if (n.kind === 'subsystem' && subs.has(n.id)) keep.set(n.id, n);
    else if (n.kind === 'component' && subs.has(n.parentId)) keep.set(n.id, n);
    else if (n.kind === 'type' && typeIds.has(n.id)) keep.set(n.id, n);
  }
  for (const n of graph.nodes) {
    if ((n.kind === 'interface' || n.kind === 'implementation') && keep.has(n.parentId)) keep.set(n.id, n);
  }
  const nodes = [...keep.values()].map((n) => {
    const { noticeCount, ...rest } = n; // a count of findings the demo does not carry
    void noticeCount;
    return rest;
  });
  return { ...graph, nodes, edges: (graph.edges ?? []).filter((e) => keep.has(e.from) && keep.has(e.to)) };
}

/** A validation result limited to the kept specs and to findings that name no path. */
export function selectFindings(result, specIds, roots) {
  let dropped = 0;
  const pick = (list) =>
    (list ?? []).filter((i) => {
      const keep = (i.specId === undefined || specIds.has(i.specId)) && !mentionsPath(JSON.stringify(i), roots);
      if (!keep) dropped++;
      return keep;
    });
  const out = { ...result };
  for (const key of ['errors', 'warnings', 'notices']) if (key in result) out[key] = pick(result[key]);
  return { result: out, dropped };
}

/**
 * The text of an MCP tool reply as JSON. A reply may trail a note after the JSON (a stale-server
 * warning); the UI needs pure JSON, so the first complete JSON value is taken and the rest dropped.
 */
export function parseToolText(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the scan */
  }
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('tool reply holds no JSON');
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('tool reply holds no complete JSON value');
}

/** A file name for one recorded spec. */
export function specFileName(kind, id) {
  return 'spec/' + kind + '__' + id.replace(/[^A-Za-z0-9_.-]+/g, '_') + '.json';
}
