import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exportSddSkills, checkSkillFreshness, skillsDirForTarget } from '../../src/core/skills.js';
import { injectGuide, writeRootGuideDelegator } from '../../src/utils/ai-guide.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// `wairon lock` / `generate` re-export the skills and re-inject the guides. On
// Windows a checkout holds them with CRLF; rewriting them LF (or the other way)
// turned every lock into a 1,000-line diff with no content change. The skills
// and guide exporters keep a file's existing line endings, as the spec writers do.
// ---------------------------------------------------------------------------

const created: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  invalidateSpecCache();
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
});

function project(): string {
  invalidateSpecCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-eol-'));
  created.push(dir);
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'p', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: '2026-07-03T10:00:00Z', updatedAt: '2026-07-03T10:00:00Z',
  }));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  return dir;
}

const toCrlf = (file: string): void => {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
};

describe('generated skills and guides keep their line endings', () => {
  it('a CRLF SKILL.md is left byte-identical by a re-export, and still reads as fresh', () => {
    project();
    exportSddSkills(['claude']);
    const dir = skillsDirForTarget('claude')!;
    const skill = path.join(dir, 'sdd-architect', 'SKILL.md');
    toCrlf(skill);
    const before = fs.readFileSync(skill);
    const mtime = fs.statSync(skill).mtimeMs;

    exportSddSkills(['claude']);

    expect(fs.readFileSync(skill).equals(before)).toBe(true);
    expect(fs.statSync(skill).mtimeMs).toBe(mtime); // unchanged content is not rewritten at all
    expect(checkSkillFreshness('claude').stale).not.toContain('sdd-architect');
  });

  it('an LF SKILL.md stays LF', () => {
    project();
    exportSddSkills(['claude']);
    const skill = path.join(skillsDirForTarget('claude')!, 'sdd-architect', 'SKILL.md');
    exportSddSkills(['claude']);
    expect(fs.readFileSync(skill, 'utf8')).not.toContain('\r\n');
  });

  it('re-injecting the guide and the root pointer keeps a CRLF file CRLF', () => {
    const dir = project();
    const guide = path.join(dir, '.claude', 'CLAUDE.md');
    injectGuide(guide, 'local');
    writeRootGuideDelegator(dir, 'claude');
    const root = path.join(dir, 'CLAUDE.md');
    toCrlf(guide);
    toCrlf(root);

    injectGuide(guide, 'local');
    writeRootGuideDelegator(dir, 'claude');

    for (const file of [guide, root]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    }
  });
});
