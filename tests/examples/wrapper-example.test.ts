import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { loadExtensions } from '../../src/core/extensions.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Golden test for examples/wrapper — the wrapper-tool template (packs +
// spec-only demo project). Keeps the shipped example honest: the demo stays
// CI-clean under its packs, and the injected doctrine actually bites.
// ---------------------------------------------------------------------------

// Resolve BEFORE any cwd mocking.
const WRAPPER_DIR = path.resolve(process.cwd(), 'examples', 'wrapper');
const DEMO_DIR = path.join(WRAPPER_DIR, 'demo-project');

const stamp = "createdAt: '2026-07-03T12:00:00Z'\nupdatedAt: '2026-07-03T12:00:00Z'";

function activate(dir: string) {
  invalidateSpecCache();
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
}

function cleanup(tempDir?: string) {
  invalidateSpecCache();
  vi.restoreAllMocks();
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
}

describe('examples/wrapper (wrapper-tool template)', () => {
  it('loads both packs: profile, language table, and one injected rule', () => {
    const ext = loadExtensions(
      [path.join(WRAPPER_DIR, 'packs', 'flowops.yaml'), path.join(WRAPPER_DIR, 'packs', 'flowops-rules.cjs')],
      DEMO_DIR,
    );
    expect(ext.errors).toEqual([]);
    expect(ext.packNames).toEqual(['flowops-doctrine', 'flowops-rules']);
    expect(ext.profiles['flowops-automation']).toBeDefined();
    expect(ext.languages.flowops?.unsupportedFlow.doWhile).toBeTruthy();
    expect(ext.rules.map(r => r.name)).toEqual(['flowops-portal-transport']);
  });

  it('demo project is completely clean under its config-injected packs', () => {
    activate(DEMO_DIR);
    try {
      const res = validateSddTree();
      expect(res.issues).toEqual([]);
      expect(res.valid).toBe(true);
    } finally { cleanup(); }
  });

  it('the doctrine bites: forbidden stereotype, portal transport, and tech leakage', () => {
    // Copy the WHOLE wrapper dir so the demo's relative ../packs refs still resolve.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-wrapper-ex-'));
    fs.cpSync(WRAPPER_DIR, path.join(tempDir, 'wrapper'), { recursive: true });
    const proj = path.join(tempDir, 'wrapper', 'demo-project');
    const componentsDir = path.join(proj, '.wai', 'specs', 'components');

    // 1. A concurrent stereotype the flowops-automation profile forbids.
    fs.writeFileSync(path.join(componentsDir, 'rogue-worker.yaml'), `schemaVersion: 1.0.0
id: rogue-worker
name: Rogue Worker
description: Long-lived background processor.
subsystem: scenario-hub
componentType: Actor
${stamp}
`);
    // 2. A request/response Portal (violates FLOWOPS_PORTAL_TRANSPORT) whose
    //    description also leaks the technology owned by sheets-adapter.
    fs.writeFileSync(path.join(componentsDir, 'admin-portal.yaml'), `schemaVersion: 1.0.0
id: admin-portal
name: Admin Portal
description: Maintenance console that edits Google Sheets rows directly.
subsystem: scenario-hub
componentType: Portal
portalType: HTTP_API
dependsOn: [routing-orchestrator]
${stamp}
`);

    activate(proj);
    try {
      const res = validateSddTree();
      const codes = res.issues.map(i => `${i.code}:${i.specId}`);
      expect(codes).toContain('PROFILE_FORBIDDEN_STEREOTYPE:rogue-worker');
      expect(codes).toContain('FLOWOPS_PORTAL_TRANSPORT:admin-portal');
      expect(codes).toContain('TECH_LEAKAGE:admin-portal');
      expect(res.valid).toBe(false);
    } finally { cleanup(tempDir); }
  });
});
