import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProjectRecord } from '../../src/server/projects.js';

// ---------------------------------------------------------------------------
// A hosted fixture family for stage 7: one family root registered as a hosted
// project, a member inside its isolated tree, and a nested member inside that
// member — each a real wairon project with its own project.yaml and L0.
//
//   platform (family root, <dataDir>/projects/platform)
//   ├── billing   (member at packages/billing)
//   │   └── payments (nested member at sub/payments)
//   └── docs      (member at packages/docs)
// ---------------------------------------------------------------------------

const STAMP = "'2026-01-01T00:00:00.000Z'";

/** A project root as wairon reads one: a configuration (optionally declaring members) and an L0. */
export function writeProject(root: string, id: string, members: Record<string, string> = {}): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  const memberLines = Object.keys(members).length
    ? ['members:', ...Object.entries(members).map(([alias, p]) => `  ${alias}: ${p}`)]
    : [];
  fs.writeFileSync(
    path.join(root, '.wai', 'project.yaml'),
    ['schemaVersion: 1.0.0', `id: ${id}`, `name: ${id}`, 'targets: []', ...memberLines, `createdAt: ${STAMP}`, `updatedAt: ${STAMP}`, ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, '.wai', 'specs', '.index.yaml'),
    ['schemaVersion: 1.0.0', `name: ${id}`, 'vision: v', 'boundaries: []', 'globalRequirements: []', `createdAt: ${STAMP}`, `updatedAt: ${STAMP}`, ''].join('\n'),
  );
}

export interface HostedFamily {
  platform: string;
  billing: string;
  payments: string;
  docs: string;
}

/** Build the fixture family under a data dir; only the family root holds a record. */
export function buildHostedFamily(dataDir: string): HostedFamily {
  const platform = createProjectRecord(dataDir, 'platform').rootPath;
  const billing = path.join(platform, 'packages', 'billing');
  const payments = path.join(billing, 'sub', 'payments');
  const docs = path.join(platform, 'packages', 'docs');
  writeProject(platform, 'platform', { billing: 'packages/billing', docs: 'packages/docs' });
  writeProject(billing, 'billing', { payments: 'sub/payments' });
  writeProject(payments, 'payments');
  writeProject(docs, 'docs');
  return { platform, billing, payments, docs };
}
