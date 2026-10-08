import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// binding_module_adapter — reads the hand-written binding modules an
// implementation names (implementation_spec.bindings): the one file where a
// consumer's code spells another project's names. A binding module is a
// declaration file — signatures and shapes, no logic — so it is read by its
// syntax, without the compiler (which stays the source analysis adapter's
// technology): comments blanked (a doc comment's `alias::name` kept for the
// declaration it precedes), strings skipped, brackets balanced. TypeScript and
// JavaScript only; any other language is answered `unsupported`, never guessed.
// ---------------------------------------------------------------------------

/** binding_member — a method (with its parameter names) or a data field a declaration holds. */
export interface BindingMember {
  name: string;
  /** A method's parameter names in order ('' for a destructured one); absent for a data field. */
  params?: string[];
}

/** binding_declaration — one exported declaration of a binding module. */
export interface BindingDeclaration {
  name: string;
  /** function | interface | class | type (an object type alias) | alias (any other type alias) | enum. */
  kind: 'function' | 'interface' | 'class' | 'type' | 'alias' | 'enum';
  /** A function's parameter names in order. */
  params?: string[];
  /** The members an interface, class or object type declares; an enum's member names as fields. */
  members: BindingMember[];
  /** The `alias::name` its leading doc comment names, when it names one. */
  tag?: string;
  /** The 1-based line the declaration starts on. */
  line: number;
}

/** binding_module — a binding module as read: where, whether it could be, and what it declares. */
export interface BindingModule {
  path: string;
  status: 'read' | 'missing' | 'escaped' | 'unreadable' | 'unsupported';
  declarations: BindingDeclaration[];
}

const READ_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * ibinding_module_adapter.readBindingModules — each distinct path read once,
 * contained within the project root, answered with its status and, when read,
 * its exported declarations in source order. Never throws for a file.
 */
export function readBindingModules(paths: readonly string[], projectRoot: string): BindingModule[] {
  const out: BindingModule[] = [];
  const seen = new Set<string>();
  // Step 1: each distinct path, in the order named.
  for (const named of paths) {
    const key = named.replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(readOne(key, projectRoot));
  }
  // Step 7.
  return out;
}

function readOne(named: string, projectRoot: string): BindingModule {
  const answer = (status: BindingModule['status'], declarations: BindingDeclaration[] = []): BindingModule => ({ path: named, status, declarations });
  // Step 2: containment — never touch a path outside the root.
  if (path.isAbsolute(named)) return answer('escaped');
  const absolute = path.resolve(projectRoot, named);
  const rel = path.relative(projectRoot, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return answer('escaped');
  // Step 3: read it.
  let buffer: Buffer;
  try {
    if (!fs.statSync(absolute).isFile()) return answer('missing');
    buffer = fs.readFileSync(absolute);
  } catch {
    return answer('missing');
  }
  if (buffer.includes(0)) return answer('unreadable');
  // Step 4: a language this reader reads.
  if (!READ_EXTENSIONS.has(path.extname(named).toLowerCase())) return answer('unsupported');
  // Steps 5-6.
  return answer('read', readDeclarations(buffer.toString('utf8')));
}

// ── the syntax-level reader ────────────────────────────────────────────────

interface Scanned {
  /** The text with every comment and string/template body blanked to spaces (same length, newlines kept). */
  clean: string;
  /** Each doc comment (`/** ... *\/`) by the index it ends at, with its text. */
  docs: { end: number; text: string }[];
}

/** Blank comments and string bodies so brackets and keywords can be read by position. */
function scan(text: string): Scanned {
  const chars = text.split('');
  const docs: { end: number; text: string }[] = [];
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      if (text[i + 2] === '*') docs.push({ end: stop, text: text.slice(i, stop) });
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      blank(i + 1, Math.min(j, text.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return { clean: chars.join(''), docs };
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** The index just past the bracket group that opens at `start` (balanced over (), [] and {}). */
function closeOf(clean: string, start: number): number {
  const stack: string[] = [];
  for (let i = start; i < clean.length; i++) {
    const c = clean[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === ')' || c === ']' || c === '}') {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return clean.length;
}

/** Split at depth-zero separators, tracking (), [], {} and type-argument angles. */
function splitTop(text: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let angle = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      // A method body or nested literal closing at depth zero ends the member.
      if (depth === 0 && c === '}' && separators.includes('\n')) {
        parts.push(text.slice(from, i + 1));
        from = i + 1;
      }
    } else if (depth === 0 && c === '<' && /[\w$]/.test(text[i - 1] ?? '')) angle++;
    else if (depth === 0 && c === '>' && angle > 0 && text[i - 1] !== '=') angle--;
    else if (depth === 0 && angle === 0 && separators.includes(c)) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

const IDENT = /^[A-Za-z_$][\w$]*/;

/** Parameter names of a parameter list's inner text: '' for a destructured one, `this` dropped. */
function paramNames(inner: string): string[] {
  const names: string[] = [];
  for (const raw of splitTop(inner, ',')) {
    const part = raw.replace(/^(?:(?:public|private|protected|readonly|override)\s+)+/, '').replace(/^\.\.\./, '').trim();
    if (part.startsWith('{') || part.startsWith('[')) {
      names.push('');
      continue;
    }
    const name = IDENT.exec(part)?.[0];
    if (name === undefined || name === 'this') continue;
    names.push(name);
  }
  return names;
}

/** Skip whitespace from `i`; the index of the next non-space character. */
function skipSpace(clean: string, i: number): number {
  while (i < clean.length && /\s/.test(clean[i])) i++;
  return i;
}

/** Skip one balanced `<...>` type-parameter list starting at `i`, if there is one. */
function skipTypeParams(clean: string, i: number): number {
  i = skipSpace(clean, i);
  if (clean[i] !== '<') return i;
  let depth = 0;
  for (; i < clean.length; i++) {
    if (clean[i] === '<') depth++;
    else if (clean[i] === '>' && clean[i - 1] !== '=') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}

/** The members of an interface, class or object type body (its inner text). */
function readMembers(body: string, isClass: boolean): BindingMember[] {
  const members: BindingMember[] = [];
  for (const raw of splitTop(body, isClass ? ';\n' : ';,\n')) {
    let seg = raw.replace(/^(?:(?:public|readonly|static|abstract|declare|override|async)\s+)+/, '');
    if (/^(?:private|protected)\b/.test(seg) || seg.startsWith('#')) continue;
    const accessor = /^(?:get|set)\s+(?=[A-Za-z_$])/.exec(seg);
    if (accessor) seg = seg.slice(accessor[0].length);
    if (seg.startsWith('[') || seg.startsWith('(') || seg.startsWith('<') || /^new\b/.test(seg)) continue;
    const name = IDENT.exec(seg)?.[0];
    if (name === undefined || name === 'constructor') continue;
    let i = name.length;
    while (seg[i] === '?' || seg[i] === '!') i++;
    if (accessor) {
      members.push({ name });
      continue;
    }
    i = skipTypeParams(seg, i);
    i = skipSpace(seg, i);
    if (seg[i] === '(') {
      members.push({ name, params: paramNames(seg.slice(i + 1, closeOf(seg, i) - 1)) });
      continue;
    }
    if (seg[i] === ':') {
      // A function-typed field is a method: `name: (a: A) => R`.
      let j = skipTypeParams(seg, i + 1);
      j = skipSpace(seg, j);
      if (seg[j] === '(') {
        const end = closeOf(seg, j);
        if (/^\s*=>/.test(seg.slice(end))) {
          members.push({ name, params: paramNames(seg.slice(j + 1, end - 1)) });
          continue;
        }
      }
    }
    members.push({ name });
  }
  return members;
}

const EXPORT_RE = /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\s*\*?|interface|class|type|enum|const\s+enum)\s+([A-Za-z_$][\w$]*)/g;
const TAG_RE = /\b([a-z0-9][a-z0-9_-]*)::([A-Za-z0-9_-]+)/;

/** Every exported declaration of a TypeScript or JavaScript binding module, in source order. */
export function readDeclarations(text: string): BindingDeclaration[] {
  const { clean, docs } = scan(text);
  const out: BindingDeclaration[] = [];
  for (const match of clean.matchAll(EXPORT_RE)) {
    const start = match.index ?? 0;
    const keyword = match[1].replace(/\s+/g, ' ').replace(/\s*\*$/, '');
    const name = match[2];
    const line = clean.slice(0, start).split('\n').length;
    const doc = docs.filter((d) => d.end <= start && clean.slice(d.end, start).trim() === '').pop();
    const tagMatch = doc ? TAG_RE.exec(doc.text) : null;
    const tag = tagMatch ? `${tagMatch[1]}::${tagMatch[2]}` : undefined;
    const base = { name, line, ...(tag ? { tag } : {}) };
    let i = start + match[0].length;
    if (keyword === 'function') {
      i = skipTypeParams(clean, i);
      i = skipSpace(clean, i);
      const params = clean[i] === '(' ? paramNames(clean.slice(i + 1, closeOf(clean, i) - 1)) : [];
      out.push({ ...base, kind: 'function', params, members: [] });
    } else if (keyword === 'interface' || keyword === 'class') {
      const open = clean.indexOf('{', i);
      const body = open < 0 ? '' : clean.slice(open + 1, closeOf(clean, open) - 1);
      out.push({ ...base, kind: keyword, members: readMembers(body, keyword === 'class') });
    } else if (keyword === 'type') {
      i = skipTypeParams(clean, i);
      i = skipSpace(clean, i);
      if (clean[i] === '=') i = skipSpace(clean, i + 1);
      if (clean[i] === '{') {
        out.push({ ...base, kind: 'type', members: readMembers(clean.slice(i + 1, closeOf(clean, i) - 1), false) });
      } else {
        out.push({ ...base, kind: 'alias', members: [] });
      }
    } else {
      const open = clean.indexOf('{', i);
      const body = open < 0 ? '' : clean.slice(open + 1, closeOf(clean, open) - 1);
      const members = splitTop(body, ',').map((m) => IDENT.exec(m)?.[0]).filter((m): m is string => m !== undefined).map((m) => ({ name: m }));
      out.push({ ...base, kind: 'enum', members });
    }
  }
  return out;
}
