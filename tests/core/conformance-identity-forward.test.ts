import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// A claimed call whose landing is a function forwarding BY IDENTITY to a
// modelled method written in another file: the caller calls the Portal's
// `pendingReviews` (republished from a module whose body is
// `new ReviewOrchestrator().pending()`). The claim names the Portal's verb, and
// what that verb calls is the Portal's own narrative — never the caller's.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function run(tree: FixtureTree): ValidationIssue[] {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-identity-forward-')));
  roots.push(dir);
  materializeFixtureProject(dir, tree);
  for (const [rel, text] of Object.entries(tree.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  setProjectRoot(dir);
  invalidateSpecCache();
  return validateProject().issues;
}

const messages = (issues: ValidationIssue[], code: string): string => issues.filter(i => i.code === code).map(i => i.message).join('\n');
const said = (issues: ValidationIssue[]): string => issues.map(i => `${i.code}: ${i.message.slice(0, 300)}`).join('\n');

function tree(claimsPortal: boolean): FixtureTree {
  return {
    system: { name: 'Reviews', vision: 'Review requests behind a portal.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'reviews', description: 'Review requests.' }],
    components: [
      { id: 'lock_adapter', componentType: 'Adapter', description: 'Runs the lock command.', dependsOn: ['review_portal'], invokedBy: { kind: 'entry', caller: 'The CLI user' } },
      { id: 'review_portal', componentType: 'Portal', transport: 'InProcess', description: 'The review API.', dependsOn: ['review_orchestrator'], invokedBy: { kind: 'entry', caller: 'Applications linking the library' } },
      { id: 'review_orchestrator', componentType: 'Orchestrator', description: 'Keeps the review requests.' },
    ],
    interfaces: [
      { id: 'ilock_adapter', component: 'lock_adapter', methods: [{ name: 'lockTree', description: 'Locks the tree.', params: [], returns: 'string', effect: 'write' }] },
      { id: 'ireview_portal', component: 'review_portal', methods: [{ name: 'pendingReviews', description: 'The pending reviews.', params: [], returns: 'string', effect: 'write' }] },
      { id: 'ireview_orchestrator', component: 'review_orchestrator', methods: [{ name: 'pending', description: 'The pending reviews.', params: [], returns: 'string', effect: 'write' }] },
    ],
    implementations: [
      {
        id: 'lock_adapter_impl', contract: 'ilock_adapter', sourcePath: 'src/cli.ts',
        methods: [{ name: 'lockTree', symbol: 'runLock', narrative: [
          ...(claimsPortal ? [{ stepNumber: 1, description: 'Bring the pending reviews up to date', type: 'call' as const, targetComponent: 'review_portal', targetMethod: 'pendingReviews' }] : []),
          { stepNumber: claimsPortal ? 2 : 1, description: 'Answer the result', type: 'return' as const, outcome: 'string' },
        ] }],
      },
      {
        id: 'review_portal_impl', contract: 'ireview_portal', sourcePath: 'src/review_portal.ts',
        methods: [{ name: 'pendingReviews', narrative: [
          { stepNumber: 1, description: 'Forward to the review orchestrator', type: 'call', targetComponent: 'review_orchestrator', targetMethod: 'pending' },
        ] }],
      },
      {
        id: 'review_orchestrator_impl', contract: 'ireview_orchestrator', sourcePath: 'src/reviews.ts',
        methods: [{ name: 'pending', detail: 'intent', intent: 'Answers the pending review requests.' }],
      },
    ],
    files: {
      'src/reviews.ts': [
        'export class ReviewOrchestrator {',
        "  pending(): string { return 'pending'; }",
        '}',
        'export const pendingReviews = (): string => new ReviewOrchestrator().pending();',
        '',
      ].join('\n'),
      'src/review_portal.ts': "export { pendingReviews } from './reviews.js';\n",
      'src/cli.ts': [
        "import { pendingReviews } from './review_portal.js';",
        'export function runLock(): string { return pendingReviews(); }',
        '',
      ].join('\n'),
    },
  };
}

describe('a claimed call landing on an identity forward of a modelled method', () => {
  it('is the claim: what the forwarding function calls is the portal verb\'s narrative, never the caller\'s UNDECLARED_WRITE_CALL', () => {
    const issues = run(tree(true));
    expect(messages(issues, 'UNDECLARED_WRITE_CALL'), said(issues)).toBe('');
    expect(messages(issues, 'UNNARRATED_CALL'), said(issues)).toBe('');
  });

  it('control: the same code with no claim to the portal verb is still an unnarrated write', () => {
    const issues = run(tree(false));
    expect(messages(issues, 'UNDECLARED_WRITE_CALL'), said(issues)).toContain('review_');
  });
});
