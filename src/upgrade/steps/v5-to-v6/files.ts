import { files } from '../../../io/index.js';
import * as path from 'path';
import { parseYaml } from '../../../utils/yaml.js';
import type { LockRecord } from '../../../core/index.js';
import { v5FormsIn, type V5FormHolder } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// v5_tree_file_adapter — raw file reads and moves over a v5 project tree.
//
// Everything here reads a tree as v5 wrote it, without the loaders of the
// running release (which no longer read every v5 form): the project.yaml
// `members` in their short and long forms, the L1 subsystem files carrying
// `projectPath`, the legacy `.wairon` folder and the undotted spec file names.
// It is all v5-only, so deleting the step deletes this file with it.
// ---------------------------------------------------------------------------

/** A project's configuration folder: `.wai`, else the legacy `.wairon`. */
function configDir(root: string): string | null {
  for (const name of ['.wai', '.wairon']) {
    const dir = path.join(root, name);
    if (files.exists(dir)) return dir;
  }
  return null;
}

/** Whether a member location names a folder on disk (not a git or hosted source). */
function localLocation(location: string): boolean {
  if (location.startsWith('hosted:') || location.includes('#')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return false;
  // scp-style git source: user@host:path
  return !/^[^/\\.][^/\\]*@[^/\\]*:/.test(location);
}

/** The local folders a project.yaml's `members` name, short and long form. */
function memberLocations(root: string, dir: string): string[] {
  const file = path.join(dir, 'project.yaml');
  if (!files.exists(file)) return [];
  let doc: unknown;
  try {
    doc = parseYaml(files.readText(file));
  } catch {
    return [];
  }
  const members = (doc as { members?: unknown } | null)?.members;
  if (!members || typeof members !== 'object') return [];
  const found: string[] = [];
  for (const entry of Object.values(members as Record<string, unknown>)) {
    const location = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object'
        ? ((entry as { source?: unknown }).source ?? (entry as { path?: unknown }).path)
        : undefined;
    if (typeof location === 'string' && localLocation(location)) found.push(path.resolve(root, location));
  }
  return found;
}

/** Every yaml file under a folder. */
function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of files.listEntries(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...yamlFiles(full));
    else if (/\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The folders the L1 subsystem files of a project mount through `projectPath`. */
function mountLocations(root: string, dir: string): string[] {
  const specs = path.join(dir, 'specs');
  if (!files.exists(specs)) return [];
  const found: string[] = [];
  for (const file of yamlFiles(specs)) {
    const text = files.readText(file);
    if (!text.includes('projectPath')) continue;
    try {
      const doc = parseYaml(text) as { projectPath?: unknown } | null;
      if (doc && typeof doc.projectPath === 'string' && doc.projectPath.trim() !== '') found.push(path.resolve(root, doc.projectPath));
    } catch {
      // A file that does not parse names no mount.
    }
  }
  return found;
}

/** iv5_tree_file_adapter.familyRoots — the project roots of the family under a root as v5 declared it, the top first. */
export function familyRoots(root: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (at: string): void => {
    const resolved = path.resolve(at);
    if (seen.has(resolved) || !files.exists(resolved)) return;
    seen.add(resolved);
    order.push(resolved);
    const dir = configDir(resolved);
    if (!dir) return;
    for (const child of [...memberLocations(resolved, dir), ...mountLocations(resolved, dir)]) visit(child);
  };
  visit(root);
  return order;
}

/** iv5_tree_file_adapter.holdsLegacyFolder — whether the root holds a .wairon folder and no .wai folder. */
export function holdsLegacyFolder(root: string): boolean {
  return files.exists(path.join(root, '.wairon')) && !files.exists(path.join(root, '.wai'));
}

/** iv5_tree_file_adapter.moveLegacyFolder — move the root's .wairon folder to .wai; a root holding .wai already is left as it is. */
export function moveLegacyFolder(root: string): void {
  if (!holdsLegacyFolder(root)) return;
  const from = path.join(root, '.wairon');
  const to = path.join(root, '.wai');
  try {
    files.rename(from, to);
  } catch {
    // A rename can be refused (an open handle on Windows); a copy then a removal moves it just as well.
    files.copy(from, to, { recursive: true });
    files.remove(from);
  }
}

/** iv5_tree_file_adapter.renameSpecFile — rename one spec file to the name the current layout expects. */
export function renameSpecFile(from: string, to: string): void {
  files.ensureDir(path.dirname(to));
  files.rename(from, to);
}

/**
 * iv5_tree_file_adapter.keepStaleRecord — a lock record wairon 5 wrote that
 * nothing proves unchanged, kept on record in the current format: who approved
 * it, when, and the identity it certified are unchanged (so it reads stale), its
 * per-spec digests are dropped (they are of another reading; the verdict then
 * says the record cannot name which specs moved), and `reexpressed` says what it
 * was. wairon 6 reads no earlier format, so without this the upgraded project
 * would hold an approval nothing can read; one `wairon lock` approves the design
 * again. Null when the root holds no record, or one already in the current format.
 */
export function keepStaleRecord(root: string): LockRecord | null {
  const dir = configDir(root);
  const file = dir ? path.join(dir, 'lock.json') : null;
  if (!file || !files.exists(file)) return null;
  const raw = JSON.parse(files.readText(file).replace(/^﻿/, '')) as Record<string, unknown> & { stateId: { algorithm: string } };
  if (raw.format === 3) return null;
  const { specs: _specs, children: _children, specsReading: _reading, format: _format, ...kept } = raw;
  const lockedBy = typeof raw.lockedBy === 'string' ? { id: raw.lockedBy, source: 'legacy' } : raw.lockedBy;
  return {
    ...kept,
    lockedBy,
    format: 3,
    reexpressed: { at: new Date().toISOString(), fromAlgorithm: raw.stateId.algorithm, fromReading: 'content', by: 'wairon upgrade' },
  } as unknown as LockRecord;
}

/** One spec file still holding a wairon 5 form, with the sentences naming each form. */
export interface V5FormsLeft {
  file: string;
  forms: string[];
}

/** A spec file's raw document, or null when it is no mapping or no YAML. */
function rawDocument(file: string): Record<string, unknown> | null {
  try {
    const doc = parseYaml(files.readText(file));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Which kind of spec a raw document is, told apart the way the loader tells them; null for one that holds no v5 form. */
function holderOf(file: string, specs: string, doc: Record<string, unknown>): V5FormHolder | null {
  if (path.dirname(file) === specs && ['.index.yaml', 'system.yaml'].includes(path.basename(file))) return 'system';
  if ('parentSystem' in doc) return 'subsystem';
  if ('componentType' in doc) return 'component';
  return 'component' in doc ? 'interface' : null;
}

/**
 * The spec files under a root's specs folder that still hold a wairon 5 form,
 * read raw (the running release refuses them): the system file, and each
 * subsystem, component and contract.
 */
export function v5FormsLeft(root: string): V5FormsLeft[] {
  const dir = configDir(root);
  const specs = dir ? path.join(dir, 'specs') : null;
  if (!specs || !files.exists(specs)) return [];
  const out: V5FormsLeft[] = [];
  for (const file of yamlFiles(specs)) {
    const doc = rawDocument(file);
    const holder = doc ? holderOf(file, specs, doc) : null;
    const forms = doc && holder ? v5FormsIn(holder, doc) : [];
    if (forms.length > 0) out.push({ file, forms });
  }
  return out;
}
