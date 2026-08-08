import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadProjectExtensions } from '../../src/core/extensions.js';
import {
  exportSddSkills,
  checkSkillFreshness,
  listSkillResources,
  readSkillResource,
  skillsDirForTarget,
} from '../../src/core/skills.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// FR 7.3 — a pack skill EXTENDS a builtin instead of standing beside it.
//
// Before this, a platform delta could only exist as a PARALLEL skill
// (appenser-make-implementer next to sdd-implement), leaving the agent to notice
// both and reconcile them — and tempting every wrapper to fork the builtin
// wholesale, which is worse for everyone. The pack's section is now appended
// under `## Platform: <pack>`, so an implementing agent reads ONE coherent
// instruction with the platform part clearly attributed, and the builtin stays
// wairon's (an upgrade still updates the base text).
// ---------------------------------------------------------------------------

const created: string[] = [];

/** A project whose pack extends sdd-implement and also ships a standalone skill. */
function projectWithPack(skillsYaml: string, files: Record<string, string> = {}) {
  invalidateSpecCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-skillcomp-'));
  created.push(dir);
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'p',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    extensions: { useGlobalPacks: false, packs: ['.wai/packs/appenser'] },
    createdAt: '2026-07-03T10:00:00Z',
    updatedAt: '2026-07-03T10:00:00Z',
  }));

  const packDir = path.join(dir, '.wai', 'packs', 'appenser');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.yaml'), `name: appenser\nversion: 1.2.0\n${skillsYaml}`);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(packDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  return dir;
}

const EXTENDING_SKILL = `---
name: make-implementer
description: Make.com implementation conventions.
---

Dispatch private methods through the method selector; never inline a Router.
`;

afterEach(() => {
  invalidateSpecCache();
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('a pack extends a builtin skill', () => {
  const EXTENDS_YAML = `skills:
  - extends: sdd-implement
    source: skills/make-implementer/SKILL.md
    targets: [claude]
`;

  it('appends the pack section to the builtin under an attributed heading', () => {
    projectWithPack(EXTENDS_YAML, { 'skills/make-implementer/SKILL.md': EXTENDING_SKILL });

    const composed = readSkillResource('sdd-implement');
    // wairon's own text is still there, first...
    expect(composed).toContain('Skill: sdd-implement');
    // ...then the platform section, attributed to the pack.
    expect(composed).toContain('## Platform: appenser');
    expect(composed).toContain('method selector');
    expect(composed.indexOf('Skill: sdd-implement')).toBeLessThan(composed.indexOf('## Platform: appenser'));
  });

  it('keeps the BUILTIN frontmatter, so the skill stays wairon\'s', () => {
    projectWithPack(EXTENDS_YAML, { 'skills/make-implementer/SKILL.md': EXTENDING_SKILL });
    const composed = readSkillResource('sdd-implement');

    // The extending file's own frontmatter is stripped — one skill, one identity.
    expect(composed).toMatch(/^---\r?\nname: sdd-implement/);
    expect(composed).not.toContain('name: make-implementer');
  });

  it('leaves the other builtins byte-identical to their templates', () => {
    projectWithPack(EXTENDS_YAML, { 'skills/make-implementer/SKILL.md': EXTENDING_SKILL });
    const templates = path.resolve(__dirname, '..', '..', 'src', 'templates', 'skills');
    for (const untouched of ['sdd-architect', 'sdd-auditor', 'sdd-delegate', 'sdd-narrative']) {
      expect(readSkillResource(untouched)).toBe(fs.readFileSync(path.join(templates, `${untouched}.md`), 'utf-8'));
    }
  });

  it('publishes NO separate resource for an extending skill', () => {
    projectWithPack(EXTENDS_YAML, { 'skills/make-implementer/SKILL.md': EXTENDING_SKILL });
    const ids = listSkillResources().map((d) => d.id);

    // One coherent instruction is the point — not two skills to reconcile.
    expect(ids).toEqual(['sdd-architect', 'sdd-auditor', 'sdd-delegate', 'sdd-implement', 'sdd-narrative']);
    expect(ids).not.toContain('appenser-make-implementer');
  });

  it('installs the composed builtin to disk, and no separate file', () => {
    const dir = projectWithPack(EXTENDS_YAML, { 'skills/make-implementer/SKILL.md': EXTENDING_SKILL });
    exportSddSkills(['claude']);

    const skillsDir = skillsDirForTarget('claude')!;
    const installed = fs.readFileSync(path.join(skillsDir, 'sdd-implement', 'SKILL.md'), 'utf-8');
    expect(installed).toContain('## Platform: appenser');
    expect(fs.existsSync(path.join(skillsDir, 'appenser-make-implementer'))).toBe(false);
    void dir;
  });

  it('does NOT report the extended skill as permanently stale', () => {
    projectWithPack(EXTENDS_YAML, { 'skills/make-implementer/SKILL.md': EXTENDING_SKILL });
    exportSddSkills(['claude']);

    // The trap: comparing an extended skill against the raw TEMPLATE would mark it
    // stale forever, telling the user to run `generate` on a loop.
    const freshness = checkSkillFreshness('claude');
    expect(freshness.stale).toEqual([]);
    expect(freshness.missing).toEqual([]);
    expect(freshness.ok).toContain('sdd-implement');
  });

  it('appends multiple packs in load order, each attributed', () => {
    const dir = projectWithPack(EXTENDS_YAML, { 'skills/make-implementer/SKILL.md': EXTENDING_SKILL });
    // A second pack extending the same builtin.
    const second = path.join(dir, '.wai', 'packs', 'zeta');
    fs.mkdirSync(path.join(second, 'skills', 's'), { recursive: true });
    fs.writeFileSync(path.join(second, 'pack.yaml'),
      'name: zeta\nskills:\n  - extends: sdd-implement\n    source: skills/s/SKILL.md\n    targets: [claude]\n');
    fs.writeFileSync(path.join(second, 'skills', 's', 'SKILL.md'), '---\nname: z\ndescription: d\n---\n\nZeta platform rules.\n');
    const cfg = path.join(dir, '.wai', 'project.yaml');
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    parsed.extensions.packs = ['.wai/packs/appenser', '.wai/packs/zeta'];
    fs.writeFileSync(cfg, JSON.stringify(parsed));

    const composed = readSkillResource('sdd-implement');
    expect(composed).toContain('## Platform: appenser');
    expect(composed).toContain('## Platform: zeta');
    // Load order is append order, so precedence is legible in the document.
    expect(composed.indexOf('## Platform: appenser')).toBeLessThan(composed.indexOf('## Platform: zeta'));
  });
});

describe('a NEW pack skill still stands on its own', () => {
  it('installs namespaced and publishes its own resource', () => {
    projectWithPack(`skills:
  - id: make-control-plane
    source: skills/cp/SKILL.md
    targets: [claude]
`, { 'skills/cp/SKILL.md': '---\nname: cp\ndescription: Control plane.\n---\n\nBody.\n' });

    expect(listSkillResources().map((d) => d.id)).toContain('appenser-make-control-plane');
    exportSddSkills(['claude']);
    const skillsDir = skillsDirForTarget('claude')!;
    expect(fs.existsSync(path.join(skillsDir, 'appenser-make-control-plane', 'SKILL.md'))).toBe(true);
  });
});

describe('an unknown extends target fails LOUDLY', () => {
  it('reports a load error rather than dropping the section', () => {
    projectWithPack(`skills:
  - extends: sdd-nonexistent
    source: skills/x/SKILL.md
    targets: [claude]
`, { 'skills/x/SKILL.md': '---\nname: x\ndescription: d\n---\n\nBody.\n' });

    const errors = loadProjectExtensions().errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('sdd-nonexistent');
    expect(errors[0]).toContain('appenser');
    // An older wairon must never silently not-apply a newer pack's doctrine.
    expect(errors[0]).toMatch(/extendable/i);
  });

  it('rejects a skill declaring both id and extends, and one declaring neither', () => {
    projectWithPack(`skills:
  - id: both
    extends: sdd-implement
    source: skills/x/SKILL.md
`, { 'skills/x/SKILL.md': 'body' });
    expect(loadProjectExtensions().errors[0]).toMatch(/either .*id.* or .*extends/i);

    projectWithPack(`skills:
  - source: skills/x/SKILL.md
`, { 'skills/x/SKILL.md': 'body' });
    expect(loadProjectExtensions().errors[0]).toMatch(/either .*id.* or .*extends/i);
  });
});
