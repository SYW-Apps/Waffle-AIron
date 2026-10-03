import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { z } from 'zod';
import { getProjectRoot } from '../utils/fs.js';
import { parseYaml, readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { readFileOrNull, writeFile } from '../utils/fs.js';
import { ProjectNotInitializedError, WaironError } from '../utils/errors.js';
import { rekeyAnchor, type CarriedRekey, type IdentityRename } from '../models/identity-rename.js';
import {
  ProjectConfigSchema,
  PROJECT_ID_RE,
  EXTERNAL_ALIAS_RE,
  USE_ENTRY_RE,
  type ProjectConfig,
  type PackSelection,
  type ProjectProfileSelection,
  type ExternalDeclaration,
  type ExternalSource,
  type MemberDeclaration,
  memberDeclarationOf,
  memberLocationOf,
  parseMemberSource,
  effectiveProjectId,
  withPack,
  type PartOf,
} from '../models/project.js';

// ---------------------------------------------------------------------------
// Project configuration Repository (sdd_core project_config_repository)
//
// `.wai/project.yaml` is held state, so it takes the Repository shape all held
// state takes. This one module realizes the facade and its four owned members
// (N:1 sourcePath):
//
//   project_config_repository   the only way in: reads → index, writes → registry
//   project_config_index        the read path, projected from the store
//   project_config_registry     one intent-level write per method, via the store
//   project_config_store        read-through holding; round-trips unknown keys
//   project_config_fs_adapter   raw YAML in and out, nothing else
//
// The members stay private. Callers get the facade, bound either to the ambient
// project root (`projectConfigRepository`) or to an explicit one
// (`projectConfigRepositoryAt`). The facade's method names ARE the contract's:
// call-step conformance matches a narrative's callee by name.
// ---------------------------------------------------------------------------

/** One `extensions.packs` entry: a legacy path reference, or a by-name selection. */
type PackEntry = string | PackSelection;

/** The facade — iproject_config_repository. */
export interface ProjectConfigRepository {
  load(): ProjectConfig | null;
  exists(): boolean;
  declaresGlobalPacks(): boolean;
  specsDir(): string;
  create(config: ProjectConfig): void;
  upsertPackSelection(selection: PackSelection): boolean;
  removePackSelection(packName: string): boolean;
  setProjectType(projectType: string): void;
  describeProject(name: string, description?: string): void;
  recordProfileSelection(selection: ProjectProfileSelection): void;
  setExecutionTier(tier: string): void;
  registerPackRef(ref: string): boolean;
  deregisterPackRef(ref: string): boolean;
  markSelectionsBundled(bundled: PackSelection[]): void;
  pinGlobalPacksAsSelections(selections: PackSelection[]): void;
  rekeyCarried(rename: IdentityRename, dryRun?: boolean): CarriedRekey[];
  setId(id: string): boolean;
  declareExternal(alias: string, declaration: ExternalDeclaration): boolean;
  declareMember(alias: string, declaration: MemberDeclaration): boolean;
  setMemberPath(alias: string, path: string): boolean;
  updateMember(alias: string, changes: MemberDeclaration): boolean;
  setPartOf(partOf: PartOf | null): boolean;
  removeMember(alias: string): boolean;
  importNames(alias: string, names: string[]): boolean;
  renameId(from: string, to: string): boolean;
  renameAlias(from: string, to: string): boolean;
  repointExternal(alias: string, project: string | null, source: ExternalSource | null): boolean;
  removeExternal(alias: string): boolean;
}

/** iproject_config_index — the read half of the facade. */
type ProjectConfigIndex = Pick<ProjectConfigRepository, 'load' | 'exists' | 'declaresGlobalPacks' | 'specsDir'>;

/** iproject_config_registry — the write half of the facade. */
type ProjectConfigRegistry = Omit<ProjectConfigRepository, keyof ProjectConfigIndex>;

// ── project_config_fs_adapter ───────────────────────────────────────────────

/** The raw document exactly as YAML produced it: no schema, no defaults. */
export type ProjectConfigDocument = unknown;

/** iproject_config_fs_adapter. */
export interface ProjectConfigFsAdapter {
  readDocument(): ProjectConfigDocument | null;
  writeDocument(document: ProjectConfigDocument): void;
  documentExists(): boolean;
  readText(): string | null;
  writeText(text: string): void;
}

/**
 * A project's `.wai` directory: `.wai/` first, then the legacy `.wairon/` of older
 * installs. The same rule as loader.ts's aiDirAt, restated here so this module
 * never imports the loader — the loader resolves its specs folder through it.
 */
function waiDirAt(root: string): string {
  const wai = path.join(root, '.wai');
  const legacy = path.join(root, '.wairon');
  return !fs.existsSync(wai) && fs.existsSync(legacy) ? legacy : wai;
}

/** The fs adapter for an explicit project root. Exported only as a test seam. */
export function projectConfigFsAdapterAt(rootDir: string): ProjectConfigFsAdapter {
  const root = path.resolve(rootDir);
  const file = (): string => path.join(waiDirAt(root), 'project.yaml');
  return {
    readDocument() {
      // null when the file is absent; a malformed document raises the YAML error naming the file.
      return readYamlFile(file());
    },
    writeDocument(document) {
      // A plain replacement, not an atomic rename — as the loader always wrote it.
      const text = readFileOrNull(file());
      // No file yet: nothing to keep, so the document is serialized fresh.
      if (text === null) {
        writeYamlFile(file(), document);
        return;
      }
      // Otherwise an EDIT of the file already there (F82): its comments, key
      // order and quoting survive, and only what changed moves.
      writeFile(file(), editDocumentText(text, document, root));
    },
    documentExists() {
      // existsSync answers false for an unreadable directory too.
      return fs.existsSync(file());
    },
    readText() {
      // The bytes as they are — comments, quoting and line endings included.
      return readFileOrNull(file());
    },
    writeText(text) {
      writeFile(file(), text);
    },
  };
}

// ── project_config_store ────────────────────────────────────────────────────

/** iproject_config_store. */
interface ProjectConfigStore {
  read(): ProjectConfig | null;
  write(config: ProjectConfig): void;
  exists(): boolean;
  declares(field: string): boolean;
  readField(field: string): ProjectConfigDocument | undefined;
  rewriteScalars(edits: ScalarEdit[], dryRun?: boolean): void;
}

/**
 * One scalar of the document to replace in place (scalar_edit): where it sits,
 * as a path of keys and sequence indexes from the document root, what it must
 * hold now, and what it holds after.
 */
export interface ScalarEdit {
  path: (string | number)[];
  from: string;
  to: string;
}

function storeOver(adapter: ProjectConfigFsAdapter, root: string): ProjectConfigStore {
  const currentDocument = (): ProjectConfigDocument | null =>
    (adapter.documentExists() ? adapter.readDocument() : null);

  return {
    read() {
      if (!adapter.documentExists()) return null;
      return parseConfig(adapter.readDocument(), root);
    },
    write(config) {
      const checked = ProjectConfigSchema.safeParse(config);
      if (!checked.success) {
        throw new WaironError(`Refusing to write an invalid .wai/project.yaml at ${root}: ${checked.error.message}`);
      }
      // A part's configuration is its schema version and partOf alone (stage 8).
      const document = config.partOf !== undefined ? { schemaVersion: config.schemaVersion, partOf: config.partOf } : config;
      adapter.writeDocument(overlayKnownFields(ProjectConfigSchema, document, currentDocument()));
    },
    exists() {
      return adapter.documentExists();
    },
    declares(field) {
      return valueAt(currentDocument(), field) !== undefined;
    },
    readField(field) {
      // The raw document, before any schema parsing, so a configuration the schema
      // rejects still yields the field.
      return valueAt(currentDocument(), field);
    },
    rewriteScalars(edits, dryRun = false) {
      if (edits.length === 0) return;
      const text = adapter.readText();
      if (text === null) throw new ProjectNotInitializedError();
      const next = rewriteScalarsInText(text, edits, root);
      if (!dryRun) adapter.writeText(next);
    },
  };
}

// ── the comment-preserving scalar edit ──────────────────────────────────────
//
// `.wai/project.yaml` is written by people as well as by wairon: it carries
// comments that say why each carried group exists and how many findings it
// holds. A write through the parsed document drops every one of them. So a
// write that only changes some scalars changes those scalars in the TEXT, in
// their own quoting, and nothing else — and proves it: the edited text is
// parsed again and must equal the document with exactly those values changed.
// A layout this edit cannot address precisely (a flow collection, a
// multi-line scalar) is refused before anything is written, naming the path.

/** One line's structure, as far as locating a scalar needs it. */
interface LineToken {
  kind: 'key' | 'item' | 'scalar';
  /** The column the key, the item's dash, or the scalar starts at. */
  col: number;
  line: number;
  /** The key's name, for a key. */
  name?: string;
  /** Where the inline value starts in the line (a key's value, a scalar item's text), when the line has one. */
  valueStart?: number;
}

const KEY_RE = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"#{}[\],&*!|>%@`][^:#]*?)\s*:(?=\s|$)/;

/** The key and item structure of the text, block scalars' bodies skipped. */
function tokenize(lines: string[]): LineToken[] {
  const tokens: LineToken[] = [];
  let blockAbove: number | null = null;
  lines.forEach((raw, line) => {
    const content = raw.replace(/\r?\n$/, '');
    const indent = content.length - content.trimStart().length;
    const trimmed = content.trim();
    if (blockAbove !== null) {
      if (trimmed === '' || indent > blockAbove) return;
      blockAbove = null;
    }
    if (trimmed === '' || trimmed.startsWith('#')) return;
    let col = indent;
    let rest = content.slice(indent);
    while (rest === '-' || rest.startsWith('- ')) {
      tokens.push({ kind: 'item', col, line });
      const after = rest.slice(1);
      const pad = after.length - after.trimStart().length;
      col += 1 + pad;
      rest = after.trimStart();
    }
    if (rest === '') return;
    const key = KEY_RE.exec(rest);
    if (key) {
      const name = key[1].startsWith("'") ? key[1].slice(1, -1).replace(/''/g, "'")
        : key[1].startsWith('"') ? JSON.parse(key[1]) as string : key[1].trim();
      const afterKey = rest.slice(key[0].length);
      const value = afterKey.trimStart();
      const token: LineToken = { kind: 'key', col, line, name };
      if (value !== '' && !value.startsWith('#')) token.valueStart = col + key[0].length + (afterKey.length - value.length);
      tokens.push(token);
      if (/^[|>][-+0-9]*\s*(#.*)?$/.test(value)) blockAbove = col;
      return;
    }
    tokens.push({ kind: 'scalar', col, line, valueStart: col });
    if (/^[|>][-+0-9]*\s*(#.*)?$/.test(rest)) blockAbove = col - 2;
  });
  return tokens;
}

/** The tokens nested under the token at `index`: everything after it until the structure returns to its column. */
function childrenOf(tokens: LineToken[], index: number): LineToken[] {
  const parent = tokens[index];
  const out: LineToken[] = [];
  for (let i = index + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    const nested = t.col > parent.col
      // A block sequence may sit at its key's own column: `key:\n- a`.
      || (parent.kind === 'key' && t.kind === 'item' && t.col === parent.col);
    if (!nested) break;
    out.push(t);
  }
  return out;
}

/** The token holding the scalar at `path`, or why it cannot be addressed precisely. */
function locateScalar(tokens: LineToken[], path: (string | number)[]): LineToken | string {
  let region = tokens;
  for (let k = 0; k < path.length; k += 1) {
    const segment = path[k];
    if (region.length === 0) return `nothing is nested at ${path.slice(0, k).join('.')}`;
    const base = Math.min(...region.map((t) => t.col));
    const last = k === path.length - 1;
    let at: number;
    if (typeof segment === 'string') {
      at = region.findIndex((t) => t.kind === 'key' && t.col === base && t.name === segment);
      if (at < 0) return `no block key "${segment}" at ${path.slice(0, k).join('.') || 'the document root'}`;
      if (last) return region[at].valueStart !== undefined ? region[at] : `"${segment}" holds no inline scalar`;
    } else {
      const items = region.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === 'item' && t.col === base);
      if (segment >= items.length) return `no block sequence item ${segment} at ${path.slice(0, k).join('.')}`;
      at = items[segment].i;
      if (last) {
        const value = region[at + 1];
        return value && value.kind === 'scalar' && value.line === region[at].line ? value : `item ${segment} holds no inline scalar`;
      }
    }
    const regionStart = tokens.indexOf(region[at]);
    region = childrenOf(tokens, regionStart);
  }
  return 'an empty path addresses no scalar';
}

/** The scalar written at the start of `text`: its value, how it was quoted, and where it ends. */
function readScalar(text: string): { value: string; style: 'plain' | 'single' | 'double'; end: number } | null {
  if (text.startsWith("'")) {
    let i = 1;
    let value = '';
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") { value += "'"; i += 2; continue; }
        return { value, style: 'single', end: i + 1 };
      }
      value += text[i];
      i += 1;
    }
    return null;
  }
  if (text.startsWith('"')) {
    const closing = /^"(?:[^"\\]|\\.)*"/.exec(text);
    if (!closing) return null;
    try {
      return { value: JSON.parse(closing[0]) as string, style: 'double', end: closing[0].length };
    } catch {
      return null;
    }
  }
  const comment = text.search(/\s#/);
  const body = (comment < 0 ? text : text.slice(0, comment)).trimEnd();
  return { value: body, style: 'plain', end: body.length };
}

/** A value written in the style the old one was, falling back to single quotes where plain would read differently. */
function writeScalar(value: string, style: 'plain' | 'single' | 'double'): string {
  if (style === 'double') return JSON.stringify(value);
  if (style === 'plain' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/** The document with the value at `path` set, for the proof. */
function setAt(document: unknown, path: (string | number)[], value: string): void {
  let node = document as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) node = node[segment] as Record<string | number, unknown>;
  node[path[path.length - 1]] = value;
}

/**
 * Replace the named scalars in the document's text and nothing else: each is
 * located by walking its path through the block structure, checked to hold
 * `from`, and rewritten in its own quoting (plain stays plain where plain reads
 * the same). The result is parsed again and must equal the original document
 * with exactly those values changed — anything else is refused, and nothing is
 * returned for the caller to write.
 */
function rewriteScalarsInText(text: string, edits: ScalarEdit[], root: string): string {
  const refuse = (why: string): never => {
    throw new WaironError(`Cannot rewrite .wai/project.yaml at ${root} without disturbing its formatting: ${why}. Nothing was written.`);
  };
  const lines = text.split(/(?<=\n)/);
  const tokens = tokenize(lines);
  const expected = parseYaml(text);
  for (const edit of edits) {
    const where = edit.path.join('.');
    const token = locateScalar(tokens, edit.path);
    if (typeof token === 'string') refuse(`${where}: ${token}`);
    const { line, valueStart } = token as LineToken;
    const content = lines[line].replace(/\r?\n$/, '');
    const ending = lines[line].slice(content.length);
    const scalar = readScalar(content.slice(valueStart!));
    if (!scalar) refuse(`${where}: the scalar there is not written on one line`);
    if (scalar!.value !== edit.from) refuse(`${where} holds "${scalar!.value}", not "${edit.from}"`);
    lines[line] = content.slice(0, valueStart!) + writeScalar(edit.to, scalar!.style)
      + content.slice(valueStart! + scalar!.end) + ending;
    setAt(expected, edit.path, edit.to);
  }
  const next = lines.join('');
  if (JSON.stringify(parseYaml(next)) !== JSON.stringify(expected)) {
    refuse('the edited text does not read back as exactly the intended change');
  }
  return next;
}

// ── the comment-preserving document write (F82) ─────────────────────────────
//
// Every registry save used to re-serialize a plain object, which dropped every
// comment in the file — the debt register's carried-group notes among them.
// The write is now an edit: the file is parsed with the `yaml` package (v2)
// into its node tree, whose nodes carry their comments and the exact source
// range they were read from; the tree is reconciled against the document to
// write; and each difference becomes one splice of the source at the range of
// the node that differs. A node that did not change is never re-serialized —
// that is the whole point — so its comments, quoting, folding and blank lines
// survive byte for byte. (yaml's own Document serializer keeps comments, but
// re-folds every folded scalar, which would rewrite most of this repository's
// project.yaml on any save.) The edited text is parsed again, by the parser
// every read uses, and must equal the document; otherwise nothing is written.

/** One splice of the source text: replace [start, end) with `text`. */
interface TextSplice {
  start: number;
  end: number;
  text: string;
  /**
   * Orders several insertions at one offset, lower first: a key inserted into
   * a deeper mapping precedes one inserted into the mapping around it, so the
   * nested key stays inside its own block.
   */
  rank: number;
}

/** A value the edit compares and writes: what js-yaml reads, and what the store hands down. */
type PlainValue = unknown;

/** The options new YAML text is written with — the loader's own style (2-space indent, sequences indented). */
const FRESH_TEXT_OPTIONS: YAML.DocumentOptions & YAML.SchemaOptions & YAML.ToStringOptions = {
  indent: 2, indentSeq: true, lineWidth: 100, customTags: ['timestamp'],
};

/** Parse options that read scalars the way js-yaml's default schema does (timestamps included). */
const PARSE_OPTIONS: YAML.ParseOptions & YAML.DocumentOptions & YAML.SchemaOptions = { customTags: ['timestamp'] };

/** Deep equality of two plain values, key order ignored, dates by instant. */
function sameValue(a: PlainValue, b: PlainValue): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
    return keysA.length === keysB.length && keysA.every((k) => hasOwn(b, k) && sameValue(a[k], b[k]));
  }
  return a === b;
}

/** The start of the line holding `pos`. */
function lineStartOf(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

/** The start of the line after the one `pos` sits on; `pos` itself when it already starts a line. */
function lineEndFrom(text: string, pos: number): number {
  if (pos === 0 || text[pos - 1] === '\n') return pos;
  const newline = text.indexOf('\n', pos);
  return newline < 0 ? text.length : newline + 1;
}

/** `text` with every non-empty line indented by `col` spaces, ending in a newline. */
function indentBlock(text: string, col: number): string {
  const pad = ' '.repeat(col);
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return body.split('\n').map((line, i, all) => (line === '' || i === all.length - 1 ? line : pad + line)).join('\n');
}

/** Fresh YAML for `value`, as block text at column `col`. */
function freshBlock(value: PlainValue, col: number): string {
  return indentBlock(YAML.stringify(value, FRESH_TEXT_OPTIONS), col);
}

/**
 * The field order the ProjectConfig schema declares for the mapping at `at`
 * (keys and sequence indexes from the document root), or null where the
 * schema names no fields there — a record (`externals`) or an unknown key.
 * Placement only: nothing here validates.
 */
function schemaFieldOrder(at: (string | number)[]): string[] | null {
  const objectsOf = (schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape>[] => {
    const shape = shapeOf(schema);
    if (shape instanceof z.ZodObject) return [shape];
    if (shape instanceof z.ZodUnion) return (shape._def.options as z.ZodTypeAny[]).flatMap(objectsOf);
    return [];
  };
  let current: z.ZodTypeAny | null = ProjectConfigSchema;
  for (const segment of at) {
    if (current === null) return null;
    const shape = shapeOf(current);
    if (typeof segment === 'number') {
      current = shape instanceof z.ZodArray ? shape.element as z.ZodTypeAny : null;
    } else if (shape instanceof z.ZodRecord) {
      current = shape._def.valueType as z.ZodTypeAny;
    } else {
      current = objectsOf(current).map((o) => o.shape[segment] as z.ZodTypeAny | undefined).find((s) => s !== undefined) ?? null;
    }
  }
  if (current === null) return null;
  const fields = objectsOf(current).flatMap((o) => Object.keys(o.shape));
  return fields.length > 0 ? [...new Set(fields)] : null;
}

/** One scalar written on one line in the given style, or null when it cannot be. */
function inlineScalar(value: PlainValue, style: YAML.Scalar['type']): string | null {
  if (value !== null && typeof value === 'object') return null;
  const quoting = style === 'QUOTE_SINGLE' || style === 'QUOTE_DOUBLE' ? style : 'PLAIN';
  const text = YAML.stringify(value, { ...FRESH_TEXT_OPTIONS, lineWidth: 0, defaultStringType: quoting }).replace(/\n$/, '');
  return text.includes('\n') ? null : text;
}

/** Collects the splices that turn the parsed file into the document. */
class DocumentReconciler {
  readonly splices: TextSplice[] = [];

  constructor(private readonly text: string, private readonly doc: YAML.Document.Parsed) {}

  /** Reconcile one node to its target; `replace` rewrites the node wholesale where an edit cannot be precise. */
  node(node: unknown, target: PlainValue, at: (string | number)[], replace: (value: PlainValue) => void): void {
    if (YAML.isNode(node) && sameValue(node.toJS(this.doc, { maxAliasCount: -1 }), target)) return;
    if (YAML.isMap(node) && !node.flow && node.items.length > 0 && isPlainObject(target) && Object.keys(target).length > 0) {
      this.mapping(node, target, at, replace);
    } else if (YAML.isSeq(node) && !node.flow && node.items.length > 0 && Array.isArray(target) && target.length > 0) {
      this.sequence(node, target, at);
    } else if (YAML.isScalar(node) && !this.scalarInPlace(node, target)) {
      replace(target);
    } else if (!YAML.isScalar(node)) {
      replace(target);
    }
  }

  /** A changed one-line scalar, replaced in its own quoting; false when it is not one. */
  private scalarInPlace(node: YAML.Scalar, target: PlainValue): boolean {
    const [start, end] = node.range ?? [0, 0];
    const flowStyle = node.type === 'PLAIN' || node.type === 'QUOTE_SINGLE' || node.type === 'QUOTE_DOUBLE';
    if (!flowStyle || start === end) return false;
    const written = inlineScalar(target, node.type);
    if (written === null) return false;
    this.splices.push({ start, end, text: written, rank: 0 });
    return true;
  }

  /** Where a pair's text starts (its key's line) and ends (the line after its value). */
  private pairSpan(pair: YAML.Pair): { start: number; end: number; col: number } {
    const key = pair.key as YAML.Node;
    const start = lineStartOf(this.text, key.range![0]);
    const value = pair.value as YAML.Node | null;
    const valueEnd = value && value.range ? value.range[1] : key.range![1];
    return { start, end: lineEndFrom(this.text, valueEnd), col: key.range![0] - start };
  }

  /** Where a sequence item's text starts (its dash's line) and ends, and the dash's column. */
  private itemSpan(item: YAML.Node): { start: number; end: number; col: number } {
    let dash = item.range![0] - 1;
    while (dash >= 0 && /\s/.test(this.text[dash])) dash -= 1;
    const start = lineStartOf(this.text, dash);
    return { start, end: lineEndFrom(this.text, item.range![1]), col: dash - start };
  }

  /** The first line of the comment block directly above the line starting at `lineStart`. */
  private commentBlockStart(lineStart: number): number {
    let start = lineStart;
    while (start > 0) {
      const above = lineStartOf(this.text, start - 1);
      if (!this.text.slice(above, start).trim().startsWith('#')) break;
      start = above;
    }
    return start;
  }

  private mapping(map: YAML.YAMLMap, target: Record<string, unknown>, at: (string | number)[], replace: (value: PlainValue) => void): void {
    const written = (pair: YAML.Pair): string => String(YAML.isScalar(pair.key) ? pair.key.value : pair.key);
    const renamed = this.renamedKeys(map, target, written);
    const keyOf = (pair: YAML.Pair): string => renamed.get(pair) ?? written(pair);
    const kept = map.items.filter((pair) => target[keyOf(pair)] !== undefined);
    if (kept.length === 0) {
      replace(target);
      return;
    }
    for (const pair of map.items) {
      const key = keyOf(pair);
      const span = this.pairSpan(pair);
      const keyRange = (pair.key as YAML.Node).range;
      if (renamed.has(pair) && keyRange) this.splices.push({ start: keyRange[0], end: keyRange[1], text: key, rank: 0 });
      if (target[key] === undefined) {
        this.splices.push({ start: span.start, end: span.end, text: '', rank: 0 });
        continue;
      }
      this.node(pair.value, target[key], [...at, key], (value) => {
        this.splices.push({ start: span.start, end: span.end, text: freshBlock({ [key]: value }, span.col), rank: 0 });
      });
    }
    this.insertNewKeys(map, kept, target, at, keyOf);
  }

  /**
   * The keys renamed in place: a key the document drops whose value is, alone
   * among them, the value of exactly one key the mapping does not have — an
   * alias rekeyed. Only a plain key is renamed this way, to a key that needs
   * no quoting; anything else is a drop and an insert.
   */
  private renamedKeys(map: YAML.YAMLMap, target: Record<string, unknown>, written: (pair: YAML.Pair) => string): Map<YAML.Pair, string> {
    const out = new Map<YAML.Pair, string>();
    const present = new Set(map.items.map(written));
    const added = Object.keys(target).filter((k) => target[k] !== undefined && !present.has(k) && /^[a-z0-9_-]+$/.test(k));
    const dropped = map.items.filter((pair) => target[written(pair)] === undefined && YAML.isScalar(pair.key) && pair.key.type === 'PLAIN' && pair.key.range && YAML.isNode(pair.value));
    const valueOf = (pair: YAML.Pair): PlainValue => (pair.value as YAML.Node).toJS(this.doc, { maxAliasCount: -1 });
    for (const pair of dropped) {
      const matches = added.filter((k) => sameValue(valueOf(pair), target[k] as PlainValue));
      const rivals = dropped.filter((other) => other !== pair && matches.some((k) => sameValue(valueOf(other), target[k] as PlainValue)));
      if (matches.length === 1 && rivals.length === 0) out.set(pair, matches[0]);
    }
    return out;
  }

  /**
   * Insert the keys the document adds at their place in the schema's field
   * order: after the nearest preceding schema field the mapping keeps, else
   * before the nearest following one (above its comments), else after the
   * mapping's last key.
   */
  private insertNewKeys(
    map: YAML.YAMLMap, kept: YAML.Pair[], target: Record<string, unknown>, at: (string | number)[], keyOf: (pair: YAML.Pair) => string,
  ): void {
    const present = new Map(kept.map((pair) => [keyOf(pair), pair] as const));
    const order = schemaFieldOrder(at) ?? [];
    const col = this.pairSpan(kept[0]).col;
    const added = Object.keys(target).filter((key) => target[key] !== undefined && !map.items.some((pair) => keyOf(pair) === key));
    added.forEach((key, n) => {
      const index = order.indexOf(key);
      const before = index < 0 ? undefined : order.slice(0, index).reverse().find((k) => present.has(k));
      const after = index < 0 ? undefined : order.slice(index + 1).find((k) => present.has(k));
      const offset = before !== undefined ? this.pairSpan(present.get(before)!).end
        : after !== undefined ? this.commentBlockStart(this.pairSpan(present.get(after)!).start)
          : this.pairSpan(kept[kept.length - 1]).end;
      const rank = -at.length * 100_000 + (index < 0 ? order.length + n : index);
      this.splices.push({ start: offset, end: offset, text: freshBlock({ [key]: target[key] }, col), rank });
    });
  }

  private sequence(seq: YAML.YAMLSeq, target: unknown[], at: (string | number)[]): void {
    seq.items.forEach((item, i) => {
      const span = this.itemSpan(item as YAML.Node);
      if (i >= target.length) {
        this.splices.push({ start: span.start, end: span.end, text: '', rank: 0 });
        return;
      }
      this.node(item, target[i], [...at, i], (value) => {
        this.splices.push({ start: span.start, end: span.end, text: freshBlock([value], span.col), rank: 0 });
      });
    });
    if (target.length > seq.items.length) {
      const last = this.itemSpan(seq.items[seq.items.length - 1] as YAML.Node);
      this.splices.push({ start: last.end, end: last.end, text: freshBlock(target.slice(seq.items.length), last.col), rank: -(at.length + 1) * 100_000 });
    }
  }
}

/** Apply the splices, last first, so every offset still addresses the original text. */
function applySplices(text: string, splices: TextSplice[]): string {
  const ordered = [...splices].sort((a, b) => b.start - a.start || b.end - a.end || b.rank - a.rank);
  let out = text;
  for (const splice of ordered) out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
  return out;
}

/**
 * The file's text edited to hold `document`: parsed into the node tree,
 * reconciled, spliced, and proved — the result must read back as exactly the
 * document, or the write is refused and nothing is written. The file's line
 * endings are kept.
 */
function editDocumentText(text: string, document: PlainValue, root: string): string {
  const refuse = (why: string): never => {
    throw new WaironError(`Cannot write .wai/project.yaml at ${root} as an edit of the file: ${why}. Nothing was written.`);
  };
  const crlf = text.includes('\r\n');
  const source = crlf ? text.replace(/\r\n/g, '\n') : text;
  const doc = YAML.parseDocument(source, PARSE_OPTIONS);
  if (doc.errors.length > 0) refuse(`the file does not parse (${doc.errors[0].message})`);
  const reconciler = new DocumentReconciler(source, doc);
  reconciler.node(doc.contents, document, [], (value) => {
    reconciler.splices.push({ start: 0, end: source.length, text: YAML.stringify(value, FRESH_TEXT_OPTIONS), rank: 0 });
  });
  const edited = applySplices(source, reconciler.splices);
  let reread: unknown;
  try {
    reread = parseYaml(edited);
  } catch (e) {
    refuse(`the edited text does not parse (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!sameValue(reread, document)) refuse('the edited text does not read back as the document to write');
  return crlf ? edited.replace(/\n/g, '\r\n') : edited;
}

/** Parse the document against the schema, defaults applied, with the loader's error on failure. */
/** The stand-in timestamp a part's configuration (which records none) is read with. */
const PART_EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * A non-contained part's configuration (stage 8) holds its partOf and nothing
 * a project declares — no name, no timestamps. It is read with an empty name
 * (so it answers to no id) and stand-in timestamps, which are never written:
 * the store writes a part's configuration as its partOf alone.
 */
function asReadable(document: ProjectConfigDocument | null): ProjectConfigDocument | null {
  if (!isPlainObject(document) || document.partOf === undefined) return document;
  return { name: '', createdAt: PART_EPOCH, updatedAt: PART_EPOCH, ...document };
}

function parseConfig(document: ProjectConfigDocument | null, root: string): ProjectConfig {
  try {
    return ProjectConfigSchema.parse(asReadable(document));
  } catch (e: unknown) {
    throw new WaironError(
      `Invalid .wai/project.yaml: ${e instanceof Error ? e.message : String(e)}\n(project root: ${root})`,
    );
  }
}

/** The raw value at a top-level or dotted path, or undefined when the document does not set it. */
function valueAt(document: unknown, field: string): unknown {
  let current = document;
  for (const segment of field.split('.')) {
    if (!isPlainObject(current) || !hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Peel the wrappers that do not change what shape a value has. */
function shapeOf(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodDefault) current = current._def.innerType;
    else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap();
    else if (current instanceof z.ZodEffects) current = current.innerType();
    else if (current instanceof z.ZodLazy) current = current.schema;
    else return current;
  }
}

/**
 * The document to write: the typed value, with every key the schema does not know
 * carried over from the document on disk, at every object level.
 *
 * Known keys and every array come from the typed value, so an entry the caller
 * dropped stays dropped. Keys the schema does not know come back verbatim, so a
 * hand-added or newer key survives any write. The schema's object shapes say which
 * is which. Anything that is not an object level — arrays, scalars, unions no object
 * option accepts — is the typed value, whole.
 */
function overlayKnownFields(schema: z.ZodTypeAny, typed: unknown, onDisk: unknown): unknown {
  if (!isPlainObject(typed)) return typed;
  const shape = shapeOf(schema);
  if (shape instanceof z.ZodObject) {
    const fields = shape.shape as Record<string, z.ZodTypeAny>;
    // A passthrough or catchall object keeps foreign keys through the parse itself.
    const open = shape._def.unknownKeys === 'passthrough' || !(shape._def.catchall instanceof z.ZodNever);
    return overlayLevel(typed, onDisk, (key) => (hasOwn(fields, key) ? fields[key] : open ? z.unknown() : null));
  }
  if (shape instanceof z.ZodRecord) {
    // Every key of a record is data, so every key is known.
    const valueType = shape._def.valueType as z.ZodTypeAny;
    return overlayLevel(typed, onDisk, () => valueType);
  }
  if (shape instanceof z.ZodUnion) {
    const options = shape._def.options as z.ZodTypeAny[];
    const match = options.find((option) => shapeOf(option) instanceof z.ZodObject && option.safeParse(typed).success);
    return match ? overlayKnownFields(match, typed, onDisk) : typed;
  }
  return typed;
}

/**
 * One object level of the overlay. `schemaFor(key)` is the key's schema, or null
 * when the level does not know the key. The document's key order is kept; keys new
 * to the document are appended in the typed value's order.
 */
function overlayLevel(
  typed: Record<string, unknown>,
  onDisk: unknown,
  schemaFor: (key: string) => z.ZodTypeAny | null,
): Record<string, unknown> {
  const document = isPlainObject(onDisk) ? onDisk : {};
  const out: Record<string, unknown> = {};
  for (const [key, stored] of Object.entries(document)) {
    const schema = schemaFor(key);
    if (schema === null) out[key] = stored;
    else if (typed[key] !== undefined) out[key] = overlayKnownFields(schema, typed[key], stored);
  }
  for (const [key, value] of Object.entries(typed)) {
    if (hasOwn(document, key) || value === undefined) continue;
    const schema = schemaFor(key);
    if (schema !== null) out[key] = overlayKnownFields(schema, value, undefined);
  }
  return out;
}

// ── project_config_registry ─────────────────────────────────────────────────

/**
 * What an absent `extensions.useGlobalPacks` means: the schema's own default, read
 * from the schema so this writer and the parse can never disagree. It equals
 * extension_orchestrator's GLOBAL_PACKS_DEFAULT; a test pins the two together.
 */
const USE_GLOBAL_PACKS_DEFAULT: boolean = ProjectConfigSchema.shape.extensions.unwrap().parse({}).useGlobalPacks;

/** `extensions.useGlobalPacks` at its effective value — what globalPacksEnabled() answers. */
function effectiveUseGlobalPacks(config: ProjectConfig): boolean {
  return config.extensions?.useGlobalPacks ?? USE_GLOBAL_PACKS_DEFAULT;
}

function packsOf(config: ProjectConfig): PackEntry[] {
  return config.extensions?.packs ?? [];
}

/**
 * The configuration with `extensions.packs` replaced. It also records
 * `useGlobalPacks` at its effective value, so a project that changed its packs counts
 * as having decided about global packs.
 */
function withPacks(config: ProjectConfig, packs: PackEntry[]): ProjectConfig {
  return { ...config, extensions: { ...config.extensions, packs, useGlobalPacks: effectiveUseGlobalPacks(config) } };
}

function registryOver(store: ProjectConfigStore, root: string): ProjectConfigRegistry {
  /** The configuration to change; a project with none is refused. */
  const current = (): ProjectConfig => {
    const config = store.read();
    if (!config) throw new ProjectNotInitializedError();
    return config;
  };
  // A save never writes a defaulted id: an id is set only by a deliberate writer
  // (init, provisioning, doctor), which knows what the project should answer to.
  const save = (config: ProjectConfig): void => store.write(config);

  return {
    create(config) {
      if (store.exists()) {
        throw new WaironError(`A project configuration already exists at ${root}; creating one never overwrites it.`);
      }
      save(config);
    },
    // The four pack writes read the change through project_config.withPack —
    // the same reading a pack impact's dry run measures, so the report and the
    // write cannot disagree about what the configuration becomes.
    upsertPackSelection(selection) {
      const config = current();
      const existing = packsOf(config);
      const replaced = existing.some((entry) => typeof entry !== 'string' && entry.name === selection.name);
      save(withPacks(config, packsOf(withPack(config, selection))));
      return replaced;
    },
    removePackSelection(packName) {
      const config = current();
      const existing = packsOf(config);
      if (!existing.some((entry) => typeof entry !== 'string' && entry.name === packName)) return false;
      save(withPacks(config, packsOf(withPack(config, { name: packName }, true))));
      return true;
    },
    setProjectType(projectType) {
      save({ ...current(), projectType });
    },
    describeProject(name: string, description?: string) {
      save({ ...current(), name, ...(description !== undefined ? { description } : {}) });
    },
    recordProfileSelection(selection) {
      save({ ...current(), profileSelection: selection });
    },
    setExecutionTier(tier) {
      const config = current();
      // The contract takes a string; the store refuses a tier the schema does not know.
      save({ ...config, execution: { ...config.execution, tier: tier as ProjectConfig['execution']['tier'] } });
    },
    registerPackRef(ref) {
      const config = current();
      if (packsOf(config).includes(ref)) return false;
      save(withPacks(config, packsOf(withPack(config, ref))));
      return true;
    },
    deregisterPackRef(ref) {
      const config = current();
      if (!packsOf(config).includes(ref)) return false;
      save(withPacks(config, packsOf(withPack(config, ref, true))));
      return true;
    },
    markSelectionsBundled(bundled) {
      const config = current();
      save(withPacks(config, bundleInPlace(packsOf(config), bundled)));
    },
    pinGlobalPacksAsSelections(selections) {
      const config = current();
      save({
        ...config,
        extensions: { ...config.extensions, packs: [...packsOf(config), ...selections], useGlobalPacks: false },
      });
    },
    rekeyCarried(rename, dryRun = false) {
      // The register as it is WRITTEN — before schema defaults — so every
      // index below is the index of the text the store edits.
      const groups = store.readField('rules.conformance.carried');
      if (!Array.isArray(groups)) return [];
      const edits: ScalarEdit[] = [];
      const rekeys: CarriedRekey[] = [];
      groups.forEach((group, g) => {
        const findings = (group as { findings?: unknown } | null)?.findings;
        if (!Array.isArray(findings)) return;
        findings.forEach((finding, f) => {
          const entry = finding as { code?: unknown; spec?: unknown; at?: unknown; covers?: unknown } | null;
          if (!entry || typeof entry.spec !== 'string') return;
          const at = typeof entry.at === 'string' ? entry.at : undefined;
          const covers = Array.isArray(entry.covers) ? entry.covers.filter((u): u is string => typeof u === 'string') : undefined;
          const next = rekeyAnchor(rename, { spec: entry.spec, at, covers });
          const base = ['rules', 'conformance', 'carried', g, 'findings', f];
          const named = { code: String(entry.code), spec: entry.spec, at: at ?? '' };
          const change = (path: (string | number)[], field: CarriedRekey['field'], from: string, to: string): void => {
            if (from === to) return;
            edits.push({ path: [...base, ...path], from, to });
            rekeys.push({ ...named, field, from, to });
          };
          change(['spec'], 'spec', entry.spec, next.spec);
          if (at !== undefined) change(['at'], 'at', at, next.at!);
          (covers ?? []).forEach((unit, u) => change(['covers', u], 'covers', unit, next.covers![u]));
        });
      });
      // A dry run still proves the text can be edited precisely.
      store.rewriteScalars(edits, dryRun);
      return rekeys;
    },
    setId(id) {
      if (!PROJECT_ID_RE.test(id)) {
        throw new WaironError(`Refusing to declare the project id "${id}" at ${root}: it breaks the project-id grammar ([a-z0-9-_.], starting and ending alphanumeric).`);
      }
      const config = current();
      if (config.id === id) return false;
      if (config.id !== undefined) {
        throw new WaironError(
          `Refusing to declare the project id "${id}" at ${root}: the project already declares "${config.id}". `
          + 'An id is immutable; moving it is the rename migration, never a set.',
        );
      }
      save({ ...config, id });
      return true;
    },
    declareExternal(alias, declaration) {
      if (!EXTERNAL_ALIAS_RE.test(alias)) {
        throw new WaironError(`Refusing to declare the external "${alias}" at ${root}: an alias must fit [a-z0-9-_]+.`);
      }
      if (declaration.project !== undefined && !PROJECT_ID_RE.test(declaration.project)) {
        throw new WaironError(`Refusing to declare the external "${alias}" at ${root}: the producer id "${declaration.project}" breaks the project-id grammar.`);
      }
      const config = current();
      const existing = config.externals?.[alias];
      if (existing !== undefined) {
        if (sameValue(heldBinding(existing, declaration), declaration)) return false;
        throw new WaironError(
          `Refusing to declare the external "${alias}" at ${root} as ${JSON.stringify(declaration)}: `
          + `it is already declared as ${JSON.stringify(existing)}, and a declaration a person wrote is never overwritten.`,
        );
      }
      save({ ...config, externals: { ...config.externals, [alias]: declaration } });
      return true;
    },
    declareMember(alias, declaration) {
      if (!EXTERNAL_ALIAS_RE.test(alias)) {
        throw new WaironError(`Refusing to declare the member "${alias}" at ${root}: an alias must fit [a-z0-9-_]+.`);
      }
      assertMemberSource(alias, memberLocationOf(declaration), root);
      const config = current();
      if (config.externals?.[alias] !== undefined) {
        throw new WaironError(
          `Refusing to declare the member "${alias}" at ${root}: \`externals\` already declares "${alias}" as `
          + `${JSON.stringify(config.externals[alias])}, and one alias names one project.`,
        );
      }
      const written = memberValue(declaration);
      const existing = config.members?.[alias];
      if (existing !== undefined) {
        if (sameValue(memberValue(memberDeclarationOf(existing)), written)) return false;
        throw new WaironError(
          `Refusing to declare the member "${alias}" at ${root} as ${JSON.stringify(written)}: `
          + `it is already declared as ${JSON.stringify(existing)}, and a declaration a person wrote is never overwritten.`,
        );
      }
      save({ ...config, members: { ...config.members, [alias]: written } });
      return true;
    },
    importNames(alias, names) {
      // Refused before anything is read: a name that is neither `*` nor a public name.
      assertUseEntries(alias, names, root);
      const config = current();
      const held = heldImports(config, alias, root);
      // Append-only and idempotent: only names not already imported, in the
      // order given, after the ones a person wrote; `*` already imports them all.
      const added = held.includes('*') ? [] : [...new Set(names)].filter((n) => !held.includes(n));
      if (added.length === 0) return false;
      save(withImports(config, alias, [...held, ...added]));
      return true;
    },
    setMemberPath(alias, memberPath) {
      assertMemberSource(alias, memberPath, root);
      const config = current();
      const existing = config.members?.[alias];
      if (existing === undefined) {
        throw new WaironError(`Refusing to move the member "${alias}" at ${root}: \`members\` declares no "${alias}".`);
      }
      if (memberLocationOf(existing) === memberPath) return false;
      const next = memberValue({ ...memberDeclarationOf(existing), path: undefined, source: memberPath });
      save({ ...config, members: { ...config.members, [alias]: next } });
      return true;
    },
    updateMember(alias, changes) {
      const config = current();
      const existing = config.members?.[alias];
      if (existing === undefined) {
        throw new WaironError(`Refusing to update the member "${alias}" at ${root}: \`members\` declares no "${alias}".`);
      }
      const merged = mergedMember(memberDeclarationOf(existing), changes);
      assertMemberSource(alias, merged.source, root);
      assertMemberAs(alias, merged.as, root);
      const written = memberValue(merged);
      if (sameValue(existing as PlainValue, written as PlainValue)) return false;
      save({ ...config, members: { ...config.members, [alias]: written } });
      return true;
    },
    setPartOf(partOf) {
      // None yet reads as empty: a fresh part's configuration is created.
      const config = store.read();
      if (partOf !== null) {
        const declared = PROJECT_FIELDS.filter((field) => store.declares(field));
        if (declared.length > 0) {
          throw new WaironError(
            `Refusing to make the configuration at ${root} a part's: it declares ${declared.map((f) => `\`${f}\``).join(', ')}, which only a project declares. `
            + 'A project is never quietly turned into a part — `wairon member demote` moves those fields first.',
          );
        }
      }
      if (sameValue((config?.partOf ?? null) as PlainValue, partOf as PlainValue)) return false;
      if (partOf === null) {
        if (!config) return false;
        const { partOf: _dropped, ...rest } = config;
        store.write(rest as ProjectConfig);
        return true;
      }
      store.write(partConfig(partOf, config));
      return true;
    },
    removeMember(alias) {
      const config = current();
      const members = config.members;
      if (members?.[alias] === undefined) return false;
      const rest = Object.fromEntries(Object.entries(members).filter(([key]) => key !== alias));
      const next: ProjectConfig = { ...config, members: rest };
      if (Object.keys(rest).length === 0) delete next.members;
      save(next);
      return true;
    },
    renameId(from, to) {
      // Refused before anything is read: a new id outside the grammar.
      if (!PROJECT_ID_RE.test(to)) {
        throw new WaironError(`Refusing to rename the project at ${root} to "${to}": it breaks the project-id grammar ([a-z0-9-_.], starting and ending alphanumeric).`);
      }
      const config = current();
      const previous = config.previousIds ?? [];
      // Already done: the new id declared, the old one kept.
      if (config.id === to && previous.includes(from)) return false;
      // The plan was computed against another identity: nothing is written.
      const now = effectiveProjectId(config);
      if (now !== from) {
        throw new WaironError(`Refusing to rename the project at ${root} from "${from}" to "${to}": it answers to ${now === null ? 'no id' : `"${now}"`}, not "${from}".`);
      }
      save({ ...config, id: to, previousIds: previous.includes(from) ? previous : [...previous, from] });
      return true;
    },
    renameAlias(from, to) {
      if (!EXTERNAL_ALIAS_RE.test(to)) {
        throw new WaironError(`Refusing to rename the alias "${from}" at ${root} to "${to}": an alias must fit [a-z0-9-_]+.`);
      }
      const config = current();
      const holds = (alias: string): boolean => config.members?.[alias] !== undefined || config.externals?.[alias] !== undefined;
      // Already done: the old alias gone and the new one declared.
      if (!holds(from) && holds(to)) return false;
      if (!holds(from)) {
        throw new WaironError(`Refusing to rename the alias "${from}" at ${root}: neither \`members\` nor \`externals\` declares it.`);
      }
      if (holds(to)) {
        throw new WaironError(`Refusing to rename the alias "${from}" at ${root} to "${to}": "${to}" is already declared, and one alias names one project.`);
      }
      // The key renamed in place: the entry keeps its position and its value exactly as written.
      const rekey = <V>(map: Record<string, V>): Record<string, V> =>
        Object.fromEntries(Object.entries(map).map(([k, v]) => [k === from ? to : k, v]));
      save(config.members?.[from] !== undefined
        ? { ...config, members: rekey(config.members) }
        : { ...config, externals: rekey(config.externals!) });
      return true;
    },
    repointExternal(alias, project, source) {
      if (project !== null && !PROJECT_ID_RE.test(project)) {
        throw new WaironError(`Refusing to repoint the external "${alias}" at ${root}: the producer id "${project}" breaks the project-id grammar.`);
      }
      const config = current();
      const existing = config.externals?.[alias];
      if (existing === undefined) {
        throw new WaironError(`Refusing to repoint the external "${alias}" at ${root}: \`externals\` declares no "${alias}".`);
      }
      const next: ExternalDeclaration = { ...existing };
      if (project === null) delete next.project;
      else next.project = project;
      if (source === null) delete next.source;
      else next.source = { ...source };
      if (sameValue(existing as PlainValue, next as PlainValue)) return false;
      save({ ...config, externals: { ...config.externals, [alias]: next } });
      return true;
    },
    removeExternal(alias) {
      const config = current();
      const externals = config.externals;
      if (externals?.[alias] === undefined) return false;
      const rest = Object.fromEntries(Object.entries(externals).filter(([key]) => key !== alias));
      const next: ProjectConfig = { ...config, externals: rest };
      if (Object.keys(rest).length === 0) delete next.externals;
      save(next);
      return true;
    },
  };
}

/**
 * What of a held external a declaration is compared with: a declaration that
 * states no `use` leaves the imports alone (they are importNames' state), so
 * the producer binding is the same when all but the held imports agree.
 */
function heldBinding(existing: unknown, declaration: { use?: unknown }): unknown {
  if (declaration.use !== undefined || typeof existing !== 'object' || existing === null) return existing;
  return Object.fromEntries(Object.entries(existing).filter(([key]) => key !== 'use'));
}

/**
 * A member's value as it is written (stage 8): the shorthand — its source alone
 * — when it carries nothing else, else the long form with `source`. The
 * deprecated `path` key is never written: it is read as the source.
 */
function memberValue(declaration: MemberDeclaration): string | MemberDeclaration {
  const source = memberLocationOf(declaration) ?? '';
  const { as, ref, dir, description, use } = declaration;
  if (as === undefined && ref === undefined && dir === undefined && description === undefined && use === undefined) return source;
  return {
    source,
    ...(as !== undefined ? { as } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(dir !== undefined ? { dir } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(use !== undefined ? { use } : {}),
  };
}

/**
 * A member's declaration with changes merged in (stage 8): a deprecated
 * `path` becomes `source`; every field the changes name is set, an empty `as`
 * or `use` drops it, and every other field is kept.
 */
function mergedMember(held: MemberDeclaration, changes: MemberDeclaration): MemberDeclaration {
  const merged: MemberDeclaration = { ...held, path: undefined, source: memberLocationOf(held) };
  for (const [field, value] of Object.entries(changes) as [keyof MemberDeclaration, unknown][]) {
    if (value === undefined) continue;
    (merged as Record<string, unknown>)[field === 'path' ? 'source' : field] = value;
  }
  if (merged.as === '') delete merged.as;
  if (Array.isArray(merged.use) && merged.use.length === 0) delete merged.use;
  return merged;
}

/** Refuse an `as` other than part or project, before anything is written. */
function assertMemberAs(alias: string, as: string | undefined, root: string): void {
  if (as === undefined || as === 'part' || as === 'project') return;
  throw new WaironError(`Refusing to update the member "${alias}" at ${root}: \`as: ${as}\` — a member is a part or a project.`);
}

/** The fields only a project's configuration declares: a part's declares none of them (setPartOf). */
const PROJECT_FIELDS = ['id', 'members', 'externals', 'composition', 'rules', 'extensions', 'targets'];

/** A part's configuration: its schema version and partOf, nothing a project declares. */
function partConfig(partOf: PartOf, held: ProjectConfig | null): ProjectConfig {
  return parseConfig({ schemaVersion: held?.schemaVersion ?? '1.0.0', partOf }, '(part)');
}

/** Refuse a `use` entry that is neither `*` nor a public name, before anything is read. */
function assertUseEntries(alias: string, names: string[], root: string): void {
  const bad = names.find((n) => !USE_ENTRY_RE.test(n));
  if (bad !== undefined) {
    throw new WaironError(`Refusing to import "${bad}" through "${alias}" at ${root}: a \`use\` entry is \`*\` or a public name of [a-z0-9-_]+.`);
  }
}

/** The `use` an external or member under an alias holds now; refused for an alias neither declares. */
function heldImports(config: ProjectConfig, alias: string, root: string): string[] {
  const external = config.externals?.[alias];
  if (external !== undefined) return external.use ?? [];
  const member = config.members?.[alias];
  if (member !== undefined) return memberDeclarationOf(member).use ?? [];
  throw new WaironError(`Refusing to import through "${alias}" at ${root}: neither \`externals\` nor \`members\` declares "${alias}".`);
}

/** The configuration with the alias's `use` replaced; a shorthand member becomes its long form to hold it. */
function withImports(config: ProjectConfig, alias: string, use: string[]): ProjectConfig {
  const external = config.externals?.[alias];
  if (external !== undefined) return { ...config, externals: { ...config.externals, [alias]: { ...external, use } } };
  return { ...config, members: { ...config.members, [alias]: memberValue({ ...memberDeclarationOf(config.members![alias]), use }) } };
}

/**
 * Refuse a member source the one location grammar does not read — empty,
 * absolute, with an inner `..`, or a git source without its full commit —
 * before anything is read (stage 8).
 */
function assertMemberSource(alias: string, source: string | undefined, root: string): void {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new WaironError(`Refusing to declare the member "${alias}" at ${root}: its source is empty.`);
  }
  const parsed = parseMemberSource(source);
  if (parsed.problem) {
    throw new WaironError(`Refusing to declare the member "${alias}" at ${root}: ${parsed.problem}.`);
  }
}

/**
 * Each selection of a bundled pack gets that pack's version and `bundle: true`. The
 * entry stays where it is, and a pack the project does not select is skipped.
 */
function bundleInPlace(packs: PackEntry[], bundled: PackSelection[]): PackEntry[] {
  const next = [...packs];
  for (const pack of bundled) {
    next.forEach((entry, i) => {
      if (typeof entry === 'string' || entry.name !== pack.name) return;
      const marked: PackSelection = { ...entry, bundle: true };
      if (pack.version !== undefined) marked.version = pack.version;
      else delete marked.version;
      next[i] = marked;
    });
  }
  return next;
}

// ── project_config_index ────────────────────────────────────────────────────

function indexOver(store: ProjectConfigStore, root: string): ProjectConfigIndex {
  return {
    load() {
      return store.read();
    },
    exists() {
      return store.exists();
    },
    declaresGlobalPacks() {
      return store.declares('extensions.useGlobalPacks');
    },
    specsDir() {
      // Read through the store's readField (the raw document, before schema parsing),
      // so a configuration that fails the schema still locates its specs. Never throws:
      // an unreadable document falls back like a missing one.
      try {
        const declared = store.readField('paths.specsDir');
        if (declared) return path.resolve(root, declared as string);
      } catch {
        // fall back below
      }
      return path.join(waiDirAt(root), 'specs');
    },
  };
}

// ── project_config_repository ───────────────────────────────────────────────

/**
 * The Repository over a given fs adapter. Exported only as a test seam: a test
 * wraps the real adapter to observe writes.
 */
export function projectConfigRepositoryOver(adapter: ProjectConfigFsAdapter, rootDir: string): ProjectConfigRepository {
  const root = path.resolve(rootDir);
  const store = storeOver(adapter, root);
  const index = indexOver(store, root);
  const registry = registryOver(store, root);
  return {
    load() { return index.load(); },
    exists() { return index.exists(); },
    declaresGlobalPacks() { return index.declaresGlobalPacks(); },
    specsDir() { return index.specsDir(); },
    create(config) { registry.create(config); },
    upsertPackSelection(selection) { return registry.upsertPackSelection(selection); },
    removePackSelection(packName) { return registry.removePackSelection(packName); },
    setProjectType(projectType) { registry.setProjectType(projectType); },
    describeProject(name: string, description?: string) { registry.describeProject(name, description); },
    recordProfileSelection(selection) { registry.recordProfileSelection(selection); },
    setExecutionTier(tier) { registry.setExecutionTier(tier); },
    registerPackRef(ref) { return registry.registerPackRef(ref); },
    deregisterPackRef(ref) { return registry.deregisterPackRef(ref); },
    markSelectionsBundled(bundled) { registry.markSelectionsBundled(bundled); },
    pinGlobalPacksAsSelections(selections) { registry.pinGlobalPacksAsSelections(selections); },
    rekeyCarried(rename, dryRun) { return registry.rekeyCarried(rename, dryRun); },
    setId(id) { return registry.setId(id); },
    declareExternal(alias, declaration) { return registry.declareExternal(alias, declaration); },
    declareMember(alias, declaration) { return registry.declareMember(alias, declaration); },
    setMemberPath(alias, memberPath) { return registry.setMemberPath(alias, memberPath); },
    updateMember(alias, changes) { return registry.updateMember(alias, changes); },
    setPartOf(partOf) { return registry.setPartOf(partOf); },
    removeMember(alias) { return registry.removeMember(alias); },
    importNames(alias, names) { return registry.importNames(alias, names); },
    renameId(from, to) { return registry.renameId(from, to); },
    renameAlias(from, to) { return registry.renameAlias(from, to); },
    repointExternal(alias, project, source) { return registry.repointExternal(alias, project, source); },
    removeExternal(alias) { return registry.removeExternal(alias); },
  };
}

/** The Repository bound to an explicit project root. */
export function projectConfigRepositoryAt(rootDir: string): ProjectConfigRepository {
  return projectConfigRepositoryOver(projectConfigFsAdapterAt(rootDir), rootDir);
}

// The ambient facade composes the same Repository as `at`, over the root
// resolved on each call.
const bound = (): ProjectConfigRepository => {
  const rootDir = getProjectRoot();
  return projectConfigRepositoryOver(projectConfigFsAdapterAt(rootDir), rootDir);
};

/**
 * The Repository bound to the ambient project root (a request's binding, else the
 * override, else the resolved cwd), resolved again on every call.
 */
export const projectConfigRepository: ProjectConfigRepository = {
  load() { return bound().load(); },
  exists() { return bound().exists(); },
  declaresGlobalPacks() { return bound().declaresGlobalPacks(); },
  specsDir() { return bound().specsDir(); },
  create(config) { bound().create(config); },
  upsertPackSelection(selection) { return bound().upsertPackSelection(selection); },
  removePackSelection(packName) { return bound().removePackSelection(packName); },
  setProjectType(projectType) { bound().setProjectType(projectType); },
  describeProject(name: string, description?: string) { bound().describeProject(name, description); },
  recordProfileSelection(selection) { bound().recordProfileSelection(selection); },
  setExecutionTier(tier) { bound().setExecutionTier(tier); },
  registerPackRef(ref) { return bound().registerPackRef(ref); },
  deregisterPackRef(ref) { return bound().deregisterPackRef(ref); },
  markSelectionsBundled(bundled) { bound().markSelectionsBundled(bundled); },
  pinGlobalPacksAsSelections(selections) { bound().pinGlobalPacksAsSelections(selections); },
  rekeyCarried(rename, dryRun) { return bound().rekeyCarried(rename, dryRun); },
  setId(id) { return bound().setId(id); },
  declareExternal(alias, declaration) { return bound().declareExternal(alias, declaration); },
  declareMember(alias, declaration) { return bound().declareMember(alias, declaration); },
  setMemberPath(alias, memberPath) { return bound().setMemberPath(alias, memberPath); },
  updateMember(alias, changes) { return bound().updateMember(alias, changes); },
  setPartOf(partOf) { return bound().setPartOf(partOf); },
  removeMember(alias) { return bound().removeMember(alias); },
  importNames(alias, names) { return bound().importNames(alias, names); },
  renameId(from, to) { return bound().renameId(from, to); },
  renameAlias(from, to) { return bound().renameAlias(from, to); },
  repointExternal(alias, project, source) { return bound().repointExternal(alias, project, source); },
  removeExternal(alias) { return bound().removeExternal(alias); },
};
