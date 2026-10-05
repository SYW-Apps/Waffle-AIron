import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lineEndingFor, writeFile, writeFileIfChanged } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { projectConfigFsAdapterAt } from '../../src/config/project-config.js';

// ---------------------------------------------------------------------------
// Every .wai writer keeps a file's line endings: a CRLF checkout (git's
// autocrlf on Windows, or an `eol` attribute) stays CRLF through a re-save, a
// doctor repair or a migration — 270 whole-file diffs on an upgrade was the
// bug. A new file follows the convention around it.
// ---------------------------------------------------------------------------

const roots: string[] = [];
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-eol-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs', 'types'), { recursive: true });
  return root;
}
const bytes = (file: string): string => fs.readFileSync(file, 'utf8');
const bareLf = (text: string): number => text.split('\n').length - 1 - (text.split('\r\n').length - 1);

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('line endings', () => {
  it('an existing CRLF file stays CRLF, whatever endings the new text carries', () => {
    const root = project();
    const file = path.join(root, '.wai', 'specs', 'types', 'a.yaml');
    fs.writeFileSync(file, 'id: a\r\nname: a\r\n');
    writeFile(file, 'id: a\nname: b\n');
    expect(bytes(file)).toBe('id: a\r\nname: b\r\n');
  });

  it('an existing LF file stays LF', () => {
    const root = project();
    const file = path.join(root, '.wai', 'specs', 'types', 'a.yaml');
    fs.writeFileSync(file, 'id: a\nname: a\n');
    writeFile(file, 'id: a\r\nname: b\r\n');
    expect(bytes(file)).toBe('id: a\nname: b\n');
  });

  it('a new file follows the majority of the files beside it', () => {
    const root = project();
    const dir = path.join(root, '.wai', 'specs', 'types');
    fs.writeFileSync(path.join(dir, 'a.yaml'), 'id: a\r\n');
    fs.writeFileSync(path.join(dir, 'b.yaml'), 'id: b\r\n');
    fs.writeFileSync(path.join(dir, 'c.yaml'), 'id: c\n');
    const file = path.join(dir, 'new.yaml');
    writeYamlFile(file, { id: 'new', name: 'new' });
    expect(bareLf(bytes(file))).toBe(0);
    expect(bytes(file)).toContain('\r\n');
  });

  it('a new file in an empty folder follows the folders above it, up to the project', () => {
    const root = project();
    fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), 'name: x\r\nid: x\r\n');
    const file = path.join(root, '.wai', 'specs', 'billing', 'invoice', '.index.yaml');
    writeSpecFile(file, { id: 'invoice', name: 'invoice' });
    expect(bareLf(bytes(file))).toBe(0);
  });

  it('a .gitattributes eol beats the files beside it', () => {
    const root = project();
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.gitattributes'), '* text=auto\n*.yaml text eol=lf\n');
    const dir = path.join(root, '.wai', 'specs', 'types');
    fs.writeFileSync(path.join(dir, 'a.yaml'), 'id: a\r\n');
    expect(lineEndingFor(path.join(dir, 'new.yaml'))).toBe('\n');
    expect(lineEndingFor(path.join(dir, 'new.md'))).toBe('\r\n');
  });

  it('defaults to LF with nothing to follow', () => {
    const root = project();
    expect(lineEndingFor(path.join(root, '.wai', 'specs', 'types', 'new.yaml'))).toBe('\n');
  });

  it('writeFileIfChanged does not rewrite a file that differs only in its line endings', () => {
    const root = project();
    const file = path.join(root, '.wai', 'specs', 'types', 'a.yaml');
    fs.writeFileSync(file, 'id: a\r\n');
    expect(writeFileIfChanged(file, 'id: a\n')).toBe(false);
    expect(bytes(file)).toBe('id: a\r\n');
  });

  it('the spec store re-saves a CRLF spec as CRLF', () => {
    const root = project();
    const file = path.join(root, '.wai', 'specs', 'types', 'money.yaml');
    fs.writeFileSync(file, 'kind: value-object\r\nid: money\r\nname: money\r\n');
    writeSpecFile(file, { kind: 'value-object', id: 'money', name: 'Money', fields: [{ name: 'cents', type: 'int' }] });
    expect(bareLf(bytes(file))).toBe(0);
    expect(bytes(file)).toContain('name: Money\r\n');
  });

  it('a project.yaml edit keeps CRLF', () => {
    const root = project();
    const file = path.join(root, '.wai', 'project.yaml');
    fs.writeFileSync(file, '# kept\r\nschemaVersion: 1.0.0\r\nname: X\r\ntargets: []\r\n');
    const adapter = projectConfigFsAdapterAt(root);
    adapter.writeDocument({ schemaVersion: '1.0.0', name: 'X', id: 'x', targets: [] });
    expect(bareLf(bytes(file))).toBe(0);
    expect(bytes(file)).toContain('# kept\r\n');
    expect(bytes(file)).toContain('id: x\r\n');
  });
});
