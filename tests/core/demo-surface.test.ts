import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedDemoTree } from '../../src/core/demo-seed.js';
import { exportSurface } from '../../src/core/surfaces.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { buildCanvasDataModel } from '../../src/core/diagram.js';
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

  function surfacePaths(maxAudience: string): Record<string, unknown> {
    return runWithProjectRoot(base, () => {
      seedDemoTree();
      invalidateSpecCache();
      const doc = JSON.parse(exportSurface(maxAudience, 'openapi').rendered ?? '{}') as { paths?: Record<string, unknown> };
      return doc.paths ?? {};
    });
  }

  it('EXTERNAL projection: Catalog + Ordering only, excludes instance-only Payments', () => {
    const paths = surfacePaths('external');
    expect(Object.keys(paths).length).toBeGreaterThan(0);
    expect(paths).toHaveProperty('/catalog/products/{id}');
    expect(paths).toHaveProperty('/orders');
    expect(paths).not.toHaveProperty('/payments/charges');
  });

  it('FULL (project) projection: all three APIs, INCLUDING instance-only Payments', () => {
    const paths = surfacePaths('project');
    expect(paths).toHaveProperty('/catalog/products/{id}');
    expect(paths).toHaveProperty('/orders');
    expect(paths).toHaveProperty('/payments/charges'); // instance, included at the project ceiling
  });

  it('canvas model tags each published portal with its L0 gateway id (the OpenAPI deep-link tag)', () => {
    const tagOf = runWithProjectRoot(base, () => {
      seedDemoTree();
      invalidateSpecCache();
      const model = buildCanvasDataModel();
      return new Map(model.components.map(c => [c.id, c.apiTag]));
    });
    // The OpenAPI tags operations with the L0 entry id; the canvas carries the same
    // id on the backing portal so "View OpenAPI" can jump straight to its section.
    expect(tagOf.get('catalog-portal')).toBe('catalog-api');
    expect(tagOf.get('ordering-portal')).toBe('ordering-api');
    expect(tagOf.get('payments-portal')).toBe('payments-api');
    // An internal (non-published) component backs no gateway entry → no tag.
    expect(tagOf.has('catalog-orchestrator')).toBe(true); // it exists…
    expect(tagOf.get('catalog-orchestrator')).toBeUndefined(); // …but carries no API tag
  });
});
