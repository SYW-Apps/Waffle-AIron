import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { renderWaironGuide, staleDerivedDocs, writeGuideDoc, writeDomainsDoc, renderDomainsDoc } from '../../src/core/context.js';

// Round 6 (platform): `doctor` called every generated file "✓ current" by its
// version stamp, while `doctor --fix` rewrote two of them — the project context
// they embed had moved. Content staleness is reported now.
let root = '';
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows locks */ }
});

describe('staleDerivedDocs (round 6)', () => {
  it('names a derived document whose content a regenerate would change, never one that is current', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ctx-'));
    fs.mkdirSync(path.join(root, '.wai', 'context'), { recursive: true });
    fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'ctx', projectType: 'backend', targets: [], rules: {},
      createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z',
    }));
    setProjectRoot(root);
    writeGuideDoc(renderWaironGuide());
    writeDomainsDoc(renderDomainsDoc());
    expect(staleDerivedDocs()).toEqual([]);
    fs.writeFileSync(path.join(root, '.wai', 'context', 'project.md'), 'An online shop for coffee beans.\n');
    const stale = staleDerivedDocs().map((f) => path.basename(f));
    expect(stale).toEqual(['wairon-guide.md']);
  });
});
