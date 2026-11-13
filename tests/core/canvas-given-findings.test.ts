import { it, expect, afterEach } from 'vitest';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { buildCanvasDataModel } from '../../src/core/index.js';
import { buildReferenceFamily, type ReferenceFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// The canvas build draws the findings it is handed, as given, and runs no gate
// of its own then: a server runs the gate off its serving thread first and
// passes the result in. Without findings the build still runs the owner's gate.
// ---------------------------------------------------------------------------

let family: ReferenceFamily | undefined;
afterEach(() => { setProjectRoot(null); invalidateSpecCache(); family?.cleanup(); family = undefined; });

it('draws exactly the findings passed in', () => {
  family = buildReferenceFamily();
  setProjectRoot(family.top); invalidateSpecCache();
  const given = [{ severity: 'warning' as const, code: 'GIVEN_FINDING', message: 'handed in by the caller', specId: 'nowhere' }];
  const canvas = buildCanvasDataModel(undefined, given);
  expect(canvas.issues).toEqual([{ severity: 'warning', code: 'GIVEN_FINDING', message: 'handed in by the caller', specId: 'nowhere' }]);
  expect(buildCanvasDataModel(undefined, []).issues).toEqual([]);
});

it('runs the gate itself when no findings are passed', () => {
  family = buildReferenceFamily();
  setProjectRoot(family.top); invalidateSpecCache();
  const canvas = buildCanvasDataModel();
  expect(canvas.issues.some((i) => i.code === 'GIVEN_FINDING')).toBe(false);
  expect(Array.isArray(canvas.issues)).toBe(true);
});
