import { files } from '../../io/index.js';
import * as path from 'path';
import * as YAML from 'yaml';

// ---------------------------------------------------------------------------
// project_stamp_adapter — the major a project's files were written by, read
// from and written to its project.yaml as raw text.
//
// The stamp is the top-level `waironMajor:` line. It is edited as TEXT so a
// stamp changes no other byte of the file: comments, key order, quoting and
// the file's line endings (CRLF or LF) all stay. The file is the one under
// `.wai/`, or under the legacy `.wairon/` when the root holds no `.wai` folder.
// A file written in flow style (one JSON-like mapping) has no top-level lines
// to edit: it is read by parsing and rewritten as a block mapping.
// ---------------------------------------------------------------------------

const STAMP_LINE = /^waironMajor:[ \t]*([^#\r\n]*?)[ \t]*(#[^\r\n]*)?$/m;

/** The project.yaml of a root: `.wai/`, else the legacy `.wairon/` when there is no `.wai` folder. */
function configFile(root: string): string {
  const wai = path.join(root, '.wai');
  const legacy = path.join(root, '.wairon');
  return !files.exists(wai) && files.exists(legacy) ? path.join(legacy, 'project.yaml') : path.join(wai, 'project.yaml');
}

/** A file whose top-level mapping is written in flow style, `{ ... }`, rather than one key per line. */
function isFlow(text: string): boolean {
  return /^\s*\{/.test(text.replace(/^\s*#[^\n]*\n/gm, ''));
}

/** A value that is a whole number, else nothing. */
function integer(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.replace(/^["']|["']$/g, '')) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/** A flow-style file parsed as a mapping; refused when it is not one. */
function flowMapping(text: string, root: string): Record<string, unknown> {
  const parsed: unknown = YAML.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Cannot stamp ${root}: its project.yaml is not a mapping.`);
  return parsed as Record<string, unknown>;
}

/** The stamp line added after the `id:` line, else at the top of the file. */
function withStampLine(text: string, major: number, eol: string): string {
  const lines = text.split(/(?<=\n)/);
  const line = `waironMajor: ${major}${eol}`;
  const at = lines.findIndex((l) => /^id:/.test(l));
  if (at === -1) return line + text;
  // The id line may be the file's last one with no ending: give it one first.
  if (!lines[at].endsWith('\n')) lines[at] += eol;
  lines.splice(at + 1, 0, line);
  return lines.join('');
}

/** The text with its stamp set: the line replaced in place, added, or the flow mapping rewritten as a block. */
function stamped(text: string, major: number, root: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // No line to edit in flow style: set the key and write the mapping back in block style.
  if (isFlow(text)) return YAML.stringify({ ...flowMapping(text, root), waironMajor: major }).replace(/\n/g, eol);
  // Replace the value in place, keeping a trailing comment and the line's own ending.
  if (STAMP_LINE.test(text)) return text.replace(STAMP_LINE, (_all, _value, comment: string | undefined) => `waironMajor: ${major}${comment ? ` ${comment}` : ''}`);
  return withStampLine(text, major, eol);
}

/** iproject_stamp_adapter.read — the `waironMajor` the project.yaml under the root names, or nothing. */
export function read(root: string): number | null {
  const file = configFile(root);
  if (!files.exists(file)) return null;
  const text = files.readText(file);
  if (isFlow(text)) return integer(flowMapping(text, root).waironMajor);
  return integer(STAMP_LINE.exec(text)?.[1]);
}

/** iproject_stamp_adapter.holdsConfig — whether the root holds a project.yaml (a part holds none). */
export function holdsConfig(root: string): boolean {
  return files.exists(configFile(root));
}

/** iproject_stamp_adapter.write — set `waironMajor`, adding the line when missing and changing no other byte. */
export function write(root: string, major: number): void {
  const file = configFile(root);
  if (!files.exists(file)) throw new Error(`Cannot stamp ${root}: it has no project.yaml.`);
  const text = files.readText(file);
  const next = stamped(text, major, root);
  if (next !== text) files.writeText(file, next);
}
