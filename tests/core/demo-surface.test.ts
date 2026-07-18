import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedDemoTree } from '../../src/core/demo-seed.js';
import { exportSurface } from '../../src/core/surfaces.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';

// ---------------------------------------------------------------------------
// The demo (ShopFlow) publishes an L0 gateway surface, so a public share's
// OpenAPI is non-empty and testable: Catalog + Ordering (audience external)
// render as real paths; Payments (audience instance) is excluded from the
// external projection.
// ---------------------------------------------------------------------------

describe('demo OpenAPI surface (external projection)', () => {
  let base: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-demo-surface-'));
  });
  afterEach(() => {
    invalidateSpecCache();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows locks */
    }
  });

  it('projects Catalog + Ordering operations, excludes instance-only Payments', () => {
    const doc = runWithProjectRoot(base, () => {
      seedDemoTree();
      invalidateSpecCache();
      const result = exportSurface('external', 'openapi');
      return JSON.parse(result.rendered ?? '{}') as { paths?: Record<string, unknown> };
    });

    const paths = doc.paths ?? {};
    // Non-empty — the external gateway surface renders operations.
    expect(Object.keys(paths).length).toBeGreaterThan(0);
    // Catalog (external) + Ordering (external) are present…
    expect(paths).toHaveProperty('/catalog/products/{id}');
    expect(paths).toHaveProperty('/orders');
    // …Payments (audience instance) is NOT exposed in the EXTERNAL projection.
    expect(paths).not.toHaveProperty('/payments/charges');
  });
});
