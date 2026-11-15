import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exportSddSkills, checkSkillFreshness, listSkillNames } from '../../src/core/skills.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// A target marked `via: plugin` gets no built-in sdd-* skills: the export writes
// only its pack skills, removes built-in copies an earlier export left, and lists
// the target as plugin-served; the freshness check owes it nothing and reports
// the copies as duplicates.
// ---------------------------------------------------------------------------

const created: string[] = [];

const PACK_SKILL = `---
name: make-helper
description: A pack skill.
---

Pack text.
`;

function project(targets: unknown[], withPack = false): string {
  invalidateSpecCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-plugin-skills-'));
  created.push(dir);
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'p',
    projectType: 'backend',
    targets,
    rules: {},
    ...(withPack ? { extensions: { useGlobalPacks: false, packs: ['.wai/packs/appenser'] } } : {}),
    createdAt: '2026-11-15T10:00:00Z',
    updatedAt: '2026-11-15T10:00:00Z',
  }));
  if (withPack) {
    const packDir = path.join(dir, '.wai', 'packs', 'appenser');
    fs.mkdirSync(path.join(packDir, 'skills', 'make-helper'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.yaml'),
      'name: appenser\nversion: 1.0.0\nskills:\n  - id: make-helper\n    source: skills/make-helper/SKILL.md\n    targets: [claude, cursor]\n');
    fs.writeFileSync(path.join(packDir, 'skills', 'make-helper', 'SKILL.md'), PACK_SKILL);
  }
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  return dir;
}

/** Leave a built-in skill copy the way an earlier export would have. */
function leaveCopy(dir: string, ...segments: string[]): string {
  const file = path.join(dir, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'an earlier copy');
  return file;
}

afterEach(() => {
  invalidateSpecCache();
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('skills_exporter.exportSddSkills: a plugin-served target', () => {
  it('writes no built-in skill, lists the target as pluginServed, and writes the other targets as ever', () => {
    const dir = project([
      { type: 'claude', outputDir: '.claude/agents', via: 'plugin' },
      { type: 'cursor', outputDir: '.cursor/rules' },
    ]);
    const result = exportSddSkills();

    expect(result.pluginServed).toEqual(['claude']);
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'sdd-architect', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.cursor', 'skills', 'sdd-architect.md'))).toBe(true);
    expect(result.fileCount).toBe(listSkillNames().length);
    expect(result.removed).toEqual([]);
  });

  it('removes the built-in copies an earlier export left and reports them, leaving other files', () => {
    const dir = project([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    const arch = leaveCopy(dir, '.claude', 'skills', 'sdd-architect', 'SKILL.md');
    const own = leaveCopy(dir, '.claude', 'skills', 'my-own-skill', 'SKILL.md');
    leaveCopy(dir, '.claude', 'skills', 'sdd-implement', 'SKILL.md');

    const result = exportSddSkills();

    expect(result.removed.sort()).toEqual([arch, path.join(dir, '.claude', 'skills', 'sdd-implement', 'SKILL.md')].sort());
    expect(fs.existsSync(arch)).toBe(false);
    expect(fs.existsSync(own)).toBe(true);
  });

  it('still writes the pack skills for the plugin-served target', () => {
    const dir = project([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }], true);
    const result = exportSddSkills();

    expect(result.pluginServed).toEqual(['claude']);
    expect(fs.readFileSync(path.join(dir, '.claude', 'skills', 'appenser-make-helper', 'SKILL.md'), 'utf8')).toContain('Pack text.');
    expect(result.fileCount).toBe(1);
  });

  it('keeps the built-ins in a skills directory a project-served target shares', () => {
    const dir = project([
      { type: 'codex', outputDir: '.codex/agents', via: 'plugin' },
      { type: 'agy', outputDir: '.gemini/agents' },
    ]);
    const result = exportSddSkills();

    expect(result.pluginServed).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.agents', 'skills', 'sdd-architect', 'SKILL.md'))).toBe(true);
  });
});

describe('skills_exporter.checkSkillFreshness: a plugin-served target', () => {
  it('owes no built-in skill: nothing missing, stale or ok, and no duplicate when none is copied', () => {
    project([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    const f = checkSkillFreshness('claude');
    expect(f).toMatchObject({ missing: [], stale: [], ok: [], duplicate: [] });
  });

  it('lists the built-in copies still present as duplicate, and reads only', () => {
    const dir = project([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    const copy = leaveCopy(dir, '.claude', 'skills', 'sdd-auditor', 'SKILL.md');

    const f = checkSkillFreshness('claude');
    expect(f.duplicate).toEqual(['sdd-auditor']);
    expect(f.missing).toEqual([]);
    expect(f.stale).toEqual([]);
    expect(fs.existsSync(copy)).toBe(true);
  });

  it('has an empty duplicate list for a project-served target', () => {
    project([{ type: 'claude', outputDir: '.claude/agents' }]);
    exportSddSkills();
    const f = checkSkillFreshness('claude');
    expect(f.duplicate).toEqual([]);
    expect(f.ok.length).toBe(listSkillNames().length);
  });
});
