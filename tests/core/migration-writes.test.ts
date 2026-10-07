import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot, runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { declareMember, rewriteReferences } from '../../src/core/provision.js';
import { renamePin, unpin } from '../../src/core/externals.js';
import { projectIdentity } from '../../src/models/project.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import { buildContractFamily, type ContractFamily } from '../helpers/reference-family.js';
import { dirHash, pinAt } from '../helpers/family-verbs.js';

// ---------------------------------------------------------------------------
// Stage 6 wave B — the writes the family verbs make, each on its own: the
// project config Registry's renameId / renameAlias / repointExternal /
// removeExternal, core's declareMember (under the containment guard) and
// rewriteReferences (exact text at a parsed position, the whole spec refused
// when a text is not there), the surface plane's renamePin / unpin, and
// project_config.identity's `renamed`. Real files; nothing mocked.
// ---------------------------------------------------------------------------

const configText = (dir: string): string => fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8');
const lockOf = (dir: string): Record<string, { project: string; digest: string; snapshot: string }> =>
  (readYamlFile(path.join(dir, '.wai', 'externals.lock.yaml')) as { externals: Record<string, { project: string; digest: string; snapshot: string }> }).externals;

describe('stage 6 — the verbs\' writes, one at a time', () => {
  const made: ContractFamily[] = [];
  const family = (): ContractFamily => {
    const f = buildContractFamily();
    made.push(f);
    return f;
  };
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    for (const f of made.splice(0)) {
      try { f.cleanup(); } catch { /* windows locks */ }
    }
  });

  it('renameId moves the id and keeps the old one in previousIds; refuses a malformed id or a project that no longer answers to the old one; a no-op once done', () => {
    const f = family();
    const repo = projectConfigRepositoryAt(f.ledger);
    expect(() => repo.renameId('ledger', 'Bad Id')).toThrow(/project-id grammar/);
    expect(() => repo.renameId('someone-else', 'books')).toThrow(/answers to "ledger", not "someone-else"/);
    expect(repo.renameId('ledger', 'books')).toBe(true);
    expect(repo.load()).toMatchObject({ id: 'books', previousIds: ['ledger'] });
    expect(repo.renameId('ledger', 'books')).toBe(false);
    expect(repo.renameId('books', 'books-2')).toBe(true);
    expect(repo.load()?.previousIds).toEqual(['ledger', 'books']);
  });

  it('renameAlias rekeys a member or an external in place, its value and every comment kept; refuses a malformed, taken or undeclared alias; a no-op once done', () => {
    const f = family();
    const file = path.join(f.top, '.wai', 'project.yaml');
    fs.writeFileSync(file, configText(f.top).replace('members:', '# who we contain\nmembers:'));
    const repo = projectConfigRepositoryAt(f.top);
    expect(() => repo.renameAlias('ledger', 'Bad')).toThrow(/breaks \[a-z0-9-_\]\+/);
    expect(() => repo.renameAlias('ledger', 'billing')).toThrow(/already declared/);
    expect(() => repo.renameAlias('ghost', 'spirit')).toThrow(/neither `members` nor `externals` declares it/);
    expect(repo.renameAlias('ledger', 'books')).toBe(true);
    expect(configText(f.top)).toContain('# who we contain\nmembers:\n  books: ledger\n  billing: billing\n');
    expect(repo.renameAlias('ledger', 'books')).toBe(false);
    // An external keeps its whole value under the new key.
    const billing = projectConfigRepositoryAt(f.billing);
    billing.importNames('ledger', ['ledger-portal']);
    expect(billing.renameAlias('ledger', 'books')).toBe(true);
    expect(billing.load()?.externals).toEqual({ books: { use: ['ledger-portal'] } });
  });

  it('repointExternal revises the producer id and source, keeping `use` and description; null removes; an equal revision writes nothing; refuses an undeclared alias or a malformed id', () => {
    const f = family();
    const repo = projectConfigRepositoryAt(f.billing);
    repo.importNames('ledger', ['ledger-portal']);
    expect(() => repo.repointExternal('ghost', null, null)).toThrow(/declares no "ghost"/);
    expect(() => repo.repointExternal('ledger', 'Bad Id', null)).toThrow(/project-id grammar/);
    expect(repo.repointExternal('ledger', 'acme.ledger', { path: '../ledger' })).toBe(true);
    expect(repo.load()?.externals?.ledger).toEqual({ use: ['ledger-portal'], project: 'acme.ledger', source: { path: '../ledger' } });
    const bytes = configText(f.billing);
    expect(repo.repointExternal('ledger', 'acme.ledger', { path: '../ledger' })).toBe(false);
    expect(configText(f.billing)).toBe(bytes);
    expect(repo.repointExternal('ledger', null, null)).toBe(true);
    expect(repo.load()?.externals?.ledger).toEqual({ use: ['ledger-portal'] });
  });

  it('removeExternal removes one declaration (and `externals` with its last); false when there is none', () => {
    const f = family();
    const repo = projectConfigRepositoryAt(f.billing);
    expect(repo.removeExternal('ghost')).toBe(false);
    expect(repo.removeExternal('ledger')).toBe(true);
    expect(repo.load()?.externals).toBeUndefined();
  });

  it('declareMember applies the containment guard: an escaping path or the root itself is refused before anything is written', () => {
    const f = family();
    const before = dirHash(f.top);
    runWithProjectRoot(f.top, () => {
      // Stage 8: leaving the root is only ever a leading `../` (a sibling); an inner `..` that escapes is refused.
      expect(() => declareMember('away', { path: 'tools/../../elsewhere' })).toThrow(/must resolve within the project root/);
      expect(() => declareMember('self', { path: '.' })).toThrow(/the project root itself/);
    });
    expect(dirHash(f.top)).toEqual(before);
    runWithProjectRoot(f.top, () => expect(declareMember('tools', { path: 'tools', description: 'Tools' })).toBe(true));
    expect(projectConfigRepositoryAt(f.top).load()?.members?.tools).toEqual({ source: 'tools', description: 'Tools' });
  });

  it('rewriteReferences replaces exactly the text at its parsed position — a narrative target, a dependsOn entry, an L0 `from` — and refuses the whole spec when one text is not there', () => {
    const f = family();
    const component = path.join(f.billing, '.wai', 'specs', 'invoicing', 'invoice-poster', '.index.yaml');
    const implementation = path.join(f.billing, '.wai', 'specs', 'invoicing', 'invoice-poster', '.implementation.yaml');
    const componentBefore = fs.readFileSync(component, 'utf8');
    setProjectRoot(f.top);
    invalidateSpecCache();
    // Refused whole: the second edit's text is not at its position, so the first is not written either.
    expect(() => rewriteReferences('component', 'billing::invoice-poster', [
      { kind: 'component', specId: 'billing::invoice-poster', position: 'dependsOn', from: 'ledger::ledger-portal', to: 'books::ledger-portal' },
      { kind: 'component', specId: 'billing::invoice-poster', position: 'owns', from: 'ledger::ledger-portal', to: 'books::ledger-portal' },
    ])).toThrow(/"ledger::ledger-portal" \(owns\) is not at its position any more/);
    expect(fs.readFileSync(component, 'utf8')).toBe(componentBefore);
    // The same text at another position is left as it is.
    expect(rewriteReferences('implementation', 'billing::invoice-poster-impl', [
      { kind: 'implementation', specId: 'billing::invoice-poster-impl', position: 'narrative', from: 'ledger::ledger-portal', to: 'books::ledger-portal' },
    ])).toBe(true);
    expect(fs.readFileSync(implementation, 'utf8')).toContain('targetComponent: books::ledger-portal');
    expect(fs.readFileSync(component, 'utf8')).toBe(componentBefore);
    // Idempotent: the same edit again finds its `to` already there and writes nothing.
    const applied = fs.readFileSync(implementation, 'utf8');
    expect(rewriteReferences('implementation', 'billing::invoice-poster-impl', [
      { kind: 'implementation', specId: 'billing::invoice-poster-impl', position: 'narrative', from: 'ledger::ledger-portal', to: 'books::ledger-portal' },
    ])).toBe(false);
    expect(fs.readFileSync(implementation, 'utf8')).toBe(applied);
    // An edit whose text is neither there nor already rewritten is a plan made against another tree: refused.
    expect(() => rewriteReferences('implementation', 'billing::invoice-poster-impl', [
      { kind: 'implementation', specId: 'billing::invoice-poster-impl', position: 'narrative', from: 'ledger::ledger-portal', to: 'journal::ledger-portal' },
    ])).toThrow(/not at its position any more/);
    // An L0 re-export's `from`, in a member's L0 keyed by the member.
    expect(rewriteReferences('system', 'ledger', [{ kind: 'system', specId: 'ledger', position: 'publicInterfaces', from: 'books', to: 'journal' }])).toBe(true);
    expect((readYamlFile(path.join(f.ledger, '.wai', 'specs', '.index.yaml')) as { publicInterfaces: { from: string }[] }).publicInterfaces[0].from).toBe('journal');
  });

  it('renamePin carries a pin to a new alias and producer id without re-pinning — digest and `used` kept; unpin removes a pin; each answers false when there is nothing to do', () => {
    const f = family();
    pinAt(f.billing);
    const pinned = lockOf(f.billing).ledger;
    runWithProjectRoot(f.billing, () => {
      expect(renamePin('ghost', 'x', 'y')).toBe(false);
      expect(renamePin('ledger', 'books', 'books-ledger')).toBe(true);
      expect(renamePin('ledger', 'books', 'books-ledger')).toBe(false);
    });
    expect(lockOf(f.billing)).toEqual({ books: { ...pinned, project: 'books-ledger', snapshot: '.wai/externals/books.yaml' } });
    expect(fs.existsSync(path.join(f.billing, '.wai', 'externals', 'ledger.yaml'))).toBe(false);
    expect((readYamlFile(path.join(f.billing, '.wai', 'externals', 'books.yaml')) as { projectId: string }).projectId).toBe('books-ledger');
    runWithProjectRoot(f.billing, () => {
      expect(unpin('books')).toBe(true);
      expect(unpin('books')).toBe(false);
    });
    // The last entry gone, the lock file goes with it.
    expect(fs.existsSync(path.join(f.billing, '.wai', 'externals.lock.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(f.billing, '.wai', 'externals', 'books.yaml'))).toBe(false);
  });

  it('identity: an approved id kept in previousIds reads as renamed (a re-lock owed), any other move as changed', () => {
    expect(projectIdentity({ id: 'books', name: 'Books', previousIds: ['ledger'] }, 'ledger').problems.map((p) => p.kind)).toEqual(['renamed']);
    expect(projectIdentity({ id: 'books', name: 'Books', previousIds: ['other'] }, 'ledger').problems.map((p) => p.kind)).toEqual(['changed']);
    expect(projectIdentity({ id: 'books', name: 'Books', previousIds: ['ledger'] }, 'books').problems).toEqual([]);
  });
});
