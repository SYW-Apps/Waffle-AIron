import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeRootGuideDelegator, withoutRootPointer, ROOT_MARKER_START, ROOT_MARKER_END,
} from '../../src/utils/ai-guide.js';

// ---------------------------------------------------------------------------
// Round 6 (BLOCKER, two personas): `wairon init -y` replaced a repository's
// own root CLAUDE.md with the delegator, and lock / generate / doctor --fix
// deleted whatever a team appended to it. wairon now owns only its block
// between the root markers; every other byte is kept, and the unmarked
// pointer an earlier release wrote is recognised and migrated.
// ---------------------------------------------------------------------------

let dir = '';
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ } });

const fresh = (): string => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-root-')));
const read = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');

const OLD_DELEGATOR = `@.claude/CLAUDE.md

# Wairon SDD Project

This project uses the Wairon Spec-Driven Development (SDD) framework. The imported
\`.claude/CLAUDE.md\` above is your complete operating guide — you already have the
full context, so don't search the project to learn how wairon or SDD works.

To design or modify the system, invoke the **\`sdd-architect\`** skill
(in \`.claude/skills/\`). Author and validate specs with the \`sdd_*\` MCP tools;
the \`wairon\` CLI is the human developer's tool, not yours.
`;

describe('root pointer files keep the user\'s text (round 6, B1)', () => {
  it('appends wairon\'s block to an existing CLAUDE.md, keeping every byte of it', () => {
    fresh();
    const mine = '# My project\r\nOur own instructions: always run npm test.\r\n';
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), mine);
    writeRootGuideDelegator(dir, 'claude');
    const after = read('CLAUDE.md');
    expect(after.startsWith(mine)).toBe(true);
    expect(after).toContain(ROOT_MARKER_START);
    expect(after).toContain('@.claude/CLAUDE.md');
    // The block takes the file's own line endings.
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('is idempotent, and text a team appends later survives every rewrite', () => {
    fresh();
    writeRootGuideDelegator(dir, 'claude');
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), '\n# Team notes\nrun npm test before every commit\n');
    const withNotes = read('CLAUDE.md');
    writeRootGuideDelegator(dir, 'claude');
    writeRootGuideDelegator(dir, 'claude');
    expect(read('CLAUDE.md')).toBe(withNotes);
  });

  it('never imports the guide twice when the user\'s own text already does', () => {
    fresh();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@.claude/CLAUDE.md\n\n# Mine\nkeep me\n');
    writeRootGuideDelegator(dir, 'claude');
    expect(read('CLAUDE.md').split('@.claude/CLAUDE.md').length - 1).toBe(1);
    expect(read('CLAUDE.md')).toContain('keep me');
  });

  it('migrates the unmarked delegator an earlier release wrote, keeping what a team appended to it', () => {
    fresh();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `${OLD_DELEGATOR}\n# Team notes\nrun npm test\n`);
    writeRootGuideDelegator(dir, 'claude');
    const after = read('CLAUDE.md');
    expect(after.startsWith(ROOT_MARKER_START)).toBe(true);
    expect(after.match(/# Wairon SDD Project/g)).toHaveLength(1);
    expect(after.endsWith('# Team notes\nrun npm test\n')).toBe(true);
    // A file holding only the old delegator becomes only the marked block.
    fresh();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), OLD_DELEGATOR);
    writeRootGuideDelegator(dir, 'claude');
    expect(withoutRootPointer('CLAUDE.md', read('CLAUDE.md'))).toBe('');
  });

  it('GEMINI.md, .cursorrules, copilot instructions and .codexrules keep the user\'s text too', () => {
    fresh();
    const files: Array<[string, string]> = [['gemini', 'GEMINI.md'], ['cursor', '.cursorrules'], ['codex', '.codexrules'], ['copilot', path.join('.github', 'copilot-instructions.md')]];
    for (const [, file] of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), `# Ours\nkeep ${file}\n`);
    }
    for (const [target, file] of files) {
      writeRootGuideDelegator(dir, target);
      const text = read(file);
      expect(text.startsWith(`# Ours\nkeep ${file}\n`)).toBe(true);
      expect(text).toContain(ROOT_MARKER_END);
    }
  });

  it('migrates an earlier GEMINI.md (heading over a guide section) into the marked block', () => {
    fresh();
    fs.writeFileSync(path.join(dir, 'GEMINI.md'), '# Wairon SDD Project\n<!-- wairon-guide-start -->\nold guide\n<!-- wairon-guide-end -->\n\nmine\n');
    writeRootGuideDelegator(dir, 'gemini');
    const after = read('GEMINI.md');
    expect(after.match(/# Wairon SDD Project/g)).toHaveLength(1);
    expect(after).not.toContain('old guide');
    expect(after.endsWith('mine\n')).toBe(true);
  });
});
