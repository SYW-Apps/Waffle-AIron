import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { between, oldestKept } from '../../src/upgrade/chain.js';
import { read, write } from '../../src/upgrade/adapters/stamp.js';
import { notesIn, version } from '../../src/upgrade/adapters/release.js';
import { releaseNotes } from '../../src/upgrade/orchestrator.js';
import * as release from '../../src/upgrade/adapters/release.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// sdd_upgrade's pure and file-level pieces: the chain arithmetic, the stamp's
// text edit (every other byte kept, CRLF and LF alike) and the release notes.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-upgrade-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('upgrade_chain', () => {
  it('answers current, older, newer and out_of_window from the two majors', () => {
    expect(between(6, 6)).toEqual({ state: 'current', steps: [] });
    expect(between(5, 6)).toEqual({ state: 'older', steps: [{ from: 5, to: 6 }] });
    const newer = between(7, 6);
    expect(newer.state).toBe('newer');
    expect(newer.steps).toEqual([]);
    expect(newer.advice).toContain('7');
    const old = between(4, 6);
    expect(old.state).toBe('out_of_window');
    expect(old.steps).toEqual([]);
    expect(old.advice).toContain('5');
    expect(old.advice).toContain('wairon upgrade');
  });

  it('keeps a table that is contiguous and ends at the running major', () => {
    expect(oldestKept()).toBe(5);
    const steps = between(oldestKept(), WAIRON_MAJOR).steps;
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].from).toBe(oldestKept());
    steps.forEach((s, i) => {
      expect(s.to).toBe(s.from + 1);
      if (i > 0) expect(s.from).toBe(steps[i - 1].to);
    });
    expect(steps[steps.length - 1].to).toBe(WAIRON_MAJOR);
  });
});

describe('project_stamp_adapter', () => {
  function project(text: string, folder = '.wai'): string {
    const root = temp();
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, folder, 'project.yaml'), text);
    return root;
  }
  const file = (root: string, folder = '.wai'): string => fs.readFileSync(path.join(root, folder, 'project.yaml'), 'utf-8');

  it('reads nothing from an unstamped file or a root without a project.yaml', () => {
    expect(read(project('id: a\nname: A\n'))).toBeNull();
    expect(read(temp())).toBeNull();
  });

  it('adds the line after id, keeping every other byte (LF)', () => {
    const root = project('# comment\nschemaVersion: "1.0.0"\nid: a\nname: A  # keep\n');
    write(root, 6);
    expect(file(root)).toBe('# comment\nschemaVersion: "1.0.0"\nid: a\nwaironMajor: 6\nname: A  # keep\n');
    expect(read(root)).toBe(6);
  });

  it('adds the line after id, keeping every other byte (CRLF)', () => {
    const root = project('schemaVersion: "1.0.0"\r\nid: a\r\nname: A\r\n');
    write(root, 6);
    expect(file(root)).toBe('schemaVersion: "1.0.0"\r\nid: a\r\nwaironMajor: 6\r\nname: A\r\n');
  });

  it('adds the line at the top when there is no id', () => {
    const root = project('name: A\r\n');
    write(root, 6);
    expect(file(root)).toBe('waironMajor: 6\r\nname: A\r\n');
  });

  it('replaces an existing stamp in place and leaves the rest alone', () => {
    const root = project('id: a\r\nwaironMajor: 5\r\nname: A\r\n');
    expect(read(root)).toBe(5);
    write(root, 6);
    expect(file(root)).toBe('id: a\r\nwaironMajor: 6\r\nname: A\r\n');
  });

  it('stamps an id line that ends the file with no line ending', () => {
    const root = project('name: A\nid: a');
    write(root, 6);
    expect(file(root)).toBe('name: A\nid: a\nwaironMajor: 6\n');
  });

  it('falls back to .wairon/project.yaml when there is no .wai folder', () => {
    const root = project('id: a\nwaironMajor: 5\n', '.wairon');
    expect(read(root)).toBe(5);
    write(root, 6);
    expect(file(root, '.wairon')).toBe('id: a\nwaironMajor: 6\n');
    expect(fs.existsSync(path.join(root, '.wai'))).toBe(false);
  });

  it('reads and stamps a file written as one flow-style mapping, rewriting it as a block mapping', () => {
    const root = project('{"id":"a","name":"A","waironMajor":5}\n');
    expect(read(root)).toBe(5);
    write(root, 6);
    expect(read(root)).toBe(6);
    expect(file(root)).toBe('id: a\nname: A\nwaironMajor: 6\n');
  });
});

describe('installed_release_adapter and releaseNotes', () => {
  function notesFolder(files: Record<string, string>): string {
    const dir = temp();
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
  }

  it('reads bullet lines as highlights, at most five, newest version first', () => {
    const dir = notesFolder({
      '6.0.0.md': '# 6.0.0\n\n- first\n',
      '6.10.0.md': '- a\n- b\n- c\n- d\n- e\n- f\n',
      '6.2.1.md': '* star bullet\n',
      'README.md': '- not a release',
    });
    const notes = notesIn(dir);
    expect(notes.map((n) => n.version)).toEqual(['6.10.0', '6.2.1', '6.0.0']);
    expect(notes[0].highlights).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(notes[1].highlights).toEqual(['star bullet']);
  });

  it('answers no notes for a missing folder', () => {
    expect(notesIn(path.join(temp(), 'absent'))).toEqual([]);
  });

  it('ships a 6.1.0 note and reports the installed version', () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
    const note = release.notes().find((n) => n.version === '6.1.0');
    expect(note).toBeDefined();
    expect(note!.highlights.length).toBeGreaterThan(0);
    expect(note!.highlights.length).toBeLessThanOrEqual(5);
  });

  it('filters the notes after one version up to and including another', () => {
    const all = release.notes().map((n) => n.version);
    expect(all).toContain('6.1.0');
    expect(releaseNotes(null, '6.1.0').map((n) => n.version)).toEqual(['6.1.0']);
    expect(releaseNotes('6.1.0', '6.1.0')).toEqual([]);
    expect(releaseNotes('6.0.0', '6.1.0').map((n) => n.version)).toEqual(['6.1.0']);
    expect(releaseNotes('6.1.0', '9.0.0')).toEqual([]);
  });
});
