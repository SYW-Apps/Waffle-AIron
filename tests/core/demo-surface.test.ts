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
// The demo (ShopFlow) publishes an L0 gateway surface, so its OpenAPI is
// non-empty and testable at each audience ceiling. The EXTERNAL projection
// renders only externally-shareable entries (Catalog + Ordering); the FULL
// ('project') projection additionally includes the instance-internal Payments
// API. A shared diagram link captures the FULL surface so it matches the full
// canvas it is paired with; the external projection is reserved for a future
// API-only link aimed at outside 3rd parties who never see the diagram.
// ---------------------------------------------------------------------------

describe('demo OpenAPI surface projections', () => {
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

  // Union of paths across the per-portal specs (multi-spec: one doc per portal).
  function surfacePaths(maxAudience: string): Record<string, unknown> {
    return runWithProjectRoot(base, () => {
      seedDemoTree();
      invalidateSpecCache();
      const result = exportSurface(maxAudience, 'openapi');
      const specs = result.renderedSet ?? (result.rendered ? [{ document: result.rendered }] : []);
      const paths: Record<string, unknown> = {};
      for (const s of specs) {
        Object.assign(paths, (JSON.parse(s.document) as { paths?: Record<string, unknown> }).paths ?? {});
      }
      return paths;
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
    // This is the ceiling a shared DIAGRAM link captures (sharesnapshots.ts):
    // it must match the full canvas it is paired with, so every portal visible on
    // the shared diagram — Payments included — is present in its OpenAPI.
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
