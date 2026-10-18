import * as fs from 'fs';
import * as path from 'path';
import { parseYaml } from '../../../utils/yaml.js';

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
    if (fs.existsSync(dir)) return dir;
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
  if (!fs.existsSync(file)) return [];
  let doc: unknown;
  try {
    doc = parseYaml(fs.readFileSync(file, 'utf-8'));
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
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...yamlFiles(full));
    else if (/\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The folders the L1 subsystem files of a project mount through `projectPath`. */
function mountLocations(root: string, dir: string): string[] {
  const specs = path.join(dir, 'specs');
  if (!fs.existsSync(specs)) return [];
  const found: string[] = [];
  for (const file of yamlFiles(specs)) {
    const text = fs.readFileSync(file, 'utf-8');
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
    if (seen.has(resolved) || !fs.existsSync(resolved)) return;
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
  return fs.existsSync(path.join(root, '.wairon')) && !fs.existsSync(path.join(root, '.wai'));
}

/** iv5_tree_file_adapter.moveLegacyFolder — move the root's .wairon folder to .wai; a root holding .wai already is left as it is. */
export function moveLegacyFolder(root: string): void {
  if (!holdsLegacyFolder(root)) return;
  const from = path.join(root, '.wairon');
  const to = path.join(root, '.wai');
  try {
    fs.renameSync(from, to);
  } catch {
    // A rename can be refused (an open handle on Windows); a copy then a removal moves it just as well.
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** iv5_tree_file_adapter.renameSpecFile — rename one spec file to the name the current layout expects. */
export function renameSpecFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}
