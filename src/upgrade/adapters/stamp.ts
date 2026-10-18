import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// project_stamp_adapter — the major a project's files were written by, read
// from and written to its project.yaml as raw text.
//
// The stamp is the top-level `waironMajor:` line. It is edited as TEXT so a
// stamp changes no other byte of the file: comments, key order, quoting and
// the file's line endings (CRLF or LF) all stay. The file is the one under
// `.wai/`, or under the legacy `.wairon/` when the root holds no `.wai` folder.
// ---------------------------------------------------------------------------

const STAMP_LINE = /^waironMajor:[ \t]*([^#\r\n]*?)[ \t]*(#[^\r\n]*)?$/m;

/** The project.yaml of a root: `.wai/`, else the legacy `.wairon/` when there is no `.wai` folder. */
function configFile(root: string): string {
  const wai = path.join(root, '.wai');
  const legacy = path.join(root, '.wairon');
  return !fs.existsSync(wai) && fs.existsSync(legacy) ? path.join(legacy, 'project.yaml') : path.join(wai, 'project.yaml');
}

/** iproject_stamp_adapter.read — the `waironMajor` the project.yaml under the root names, or nothing. */
export function read(root: string): number | null {
  const file = configFile(root);
  if (!fs.existsSync(file)) return null;
  const found = STAMP_LINE.exec(fs.readFileSync(file, 'utf-8'));
  if (!found) return null;
  const value = Number(found[1].replace(/^["']|["']$/g, ''));
  return Number.isInteger(value) ? value : null;
}

/** iproject_stamp_adapter.write — set `waironMajor`, adding the line when missing and changing no other byte. */
export function write(root: string, major: number): void {
  const file = configFile(root);
  if (!fs.existsSync(file)) {
    throw new Error(`Cannot stamp ${root}: it has no project.yaml.`);
  }
  const text = fs.readFileSync(file, 'utf-8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let next: string;
  if (STAMP_LINE.test(text)) {
    // Replace the value in place, keeping a trailing comment and the line's own ending.
    next = text.replace(STAMP_LINE, (_all, _value, comment: string | undefined) => `waironMajor: ${major}${comment ? ` ${comment}` : ''}`);
  } else {
    const lines = text.split(/(?<=\n)/);
    const at = lines.findIndex((l) => /^id:/.test(l));
    const line = `waironMajor: ${major}${eol}`;
    if (at === -1) {
      next = line + text;
    } else {
      // The id line may be the file's last one with no ending: give it one first.
      if (!/\n$/.test(lines[at])) lines[at] += eol;
      lines.splice(at + 1, 0, line);
      next = lines.join('');
    }
  }
  if (next !== text) fs.writeFileSync(file, next);
}
