import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadExtensionPacks, discoverPacks } from '../../src/core/extensions.js';

// ---------------------------------------------------------------------------
// The dev demo packs (dev/packs/) are the fixtures a human uses to exercise
// hosted profile application by hand — docker-compose.local.yml mounts them into
// the container's image-layer pack tier, and dev/packs/README.md documents the
// exact findings each profile should produce.
//
// They are only useful if they LOAD: a pack that fails the declarative schema
// contributes nothing and simply disappears from the profile catalog (by design
// — one bad pack must never break the rest), so the kit would rot silently.
// These assertions pin the documented doctrine so a schema change that
// invalidates the fixtures fails here instead of during a manual test session.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PACKS_DIR = path.join(REPO_ROOT, 'dev', 'packs');

describe('dev demo packs (fixtures for manual profile-application testing)', () => {
  it('are discovered and load with no errors', () => {
    const refs = discoverPacks(PACKS_DIR);
    // The README's walkthrough needs BOTH packs (two contributing packs is what
    // makes the picker's source grouping and the second adoption testable).
    expect(refs.filter((r) => r.endsWith('.yaml'))).toHaveLength(2);

    const loaded = loadExtensionPacks(refs.map((ref) => ({ ref, scope: 'global' as const })), PACKS_DIR);
    expect(loaded.errors).toEqual([]);
    expect(loaded.packNames.sort()).toEqual(['demo-doctrine', 'demo-frontend-doctrine']);
  });

  it('contribute the doctrine dev/packs/README.md documents', () => {
    const refs = discoverPacks(PACKS_DIR).map((ref) => ({ ref, scope: 'global' as const }));
    const { profiles } = loadExtensionPacks(refs, PACKS_DIR);

    // demo-strict: the "visible doctrine" profile. Each of these is something the
    // README tells the tester to look for in the validate output.
    const strict = profiles['demo-strict'];
    expect(strict).toBeDefined();
    expect(strict.family).toBe('backend-like');
    expect(strict.forbiddenStereotypes[0].types).toEqual(['Actor', 'Supervisor']);
    expect(strict.discouragedStereotypes[0].types).toEqual(['Store']);
    // The profile's rules block — the half that was silently lost when the
    // contributing pack was not installed in the project.
    expect(strict.rules?.documentation?.minDescriptionLength).toBe(120);
    expect(strict.rules?.complexity?.maxComponentDependencies).toBe(3);
    expect(strict.rules?.sddRuleSeverity?.UNOWNED_STORE).toBe('error');

    // demo-frontend: flips the family and lowers the floor, so the SAME seed tree
    // yields a different verdict — that contrast is the A/B the README leans on.
    const frontend = profiles['demo-frontend'];
    expect(frontend).toBeDefined();
    expect(frontend.family).toBe('frontend-like');
    expect(frontend.rules?.documentation?.minDescriptionLength).toBe(40);
    expect(frontend.rules?.documentation?.minDescriptionLength)
      .toBeLessThan(strict.rules!.documentation!.minDescriptionLength!);
  });

  it('ship a seed spec tree whose descriptions sit BETWEEN the two floors', () => {
    // The A/B only works if the seeded descriptions trip demo-strict's floor of
    // 120 while passing demo-frontend's 40. Pin that, or the walkthrough's
    // "6 findings vs 2" contrast quietly stops being true.
    const seedDir = path.join(REPO_ROOT, 'dev', 'demo-specs', 'demo_flows');
    const specs = [
      path.join(seedDir, '.index.yaml'),
      path.join(seedDir, 'flow_runner', '.index.yaml'),
      path.join(seedDir, 'flow_store', '.index.yaml'),
    ];
    for (const file of specs) {
      const desc = /^description: (.*)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
      expect(desc.length).toBeGreaterThan(40);
      expect(desc.length).toBeLessThan(120);
    }

    // And the stereotypes the doctrine targets are actually present in the seed.
    const runner = fs.readFileSync(path.join(seedDir, 'flow_runner', '.index.yaml'), 'utf8');
    const store = fs.readFileSync(path.join(seedDir, 'flow_store', '.index.yaml'), 'utf8');
    expect(runner).toMatch(/componentType: Actor/);
    expect(store).toMatch(/componentType: Store/);
  });
});
