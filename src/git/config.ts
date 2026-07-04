import * as fs from 'fs';
import * as path from 'path';
import { aiDir } from '../utils/fs.js';
import type { GitConfig } from './types.js';

// ---------------------------------------------------------------------------
// Git Config Registry (sdd_git)
//
// File-backed I/O for a project's git-backing config (.wai/git.json), resolved
// through aiDir() so it targets whichever project is bound in the current
// (request-scoped) context. Container-local — excluded from the repo.
// ---------------------------------------------------------------------------

function configPath(): string {
  return aiDir('git.json');
}

/** Read the bound project's GitConfig, or null when not git-backed. */
export function readGitConfig(): GitConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as GitConfig;
  } catch {
    return null;
  }
}

/** Persist the bound project's GitConfig atomically. */
export function writeGitConfig(config: GitConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/** Remove the bound project's git-backing config (idempotent). */
export function clearGitConfig(): void {
  try {
    fs.rmSync(configPath(), { force: true });
  } catch {
    /* already absent */
  }
}
