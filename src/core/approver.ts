import { execFileSync } from 'child_process';
import * as os from 'os';
import type { ApproverIdentity } from './lockfile.js';

// ---------------------------------------------------------------------------
// Approver Identity Specialist (sdd_core)
//
// Who to record as having approved a lock, on a machine where wairon has no
// account of its own.
//
// The honest answer is that the strongest identity is not a field at all: the
// lock record is COMMITTED, so `git log .wai/lock.json` already says who
// approved and when, backed by whatever the repository enforces (signed
// commits, a protected branch). What is recorded here can never be worth more
// than that commit. It earns its place only where git does not follow — a
// .waitree archive, a `remote push` into a hosted instance, a tarball — so it
// is a convenience copy, and `source` is what stops it overclaiming.
//
// Preference order, and why:
//
//  1. The git author identity (`user.name <user.email>`). The one identity the
//     repository already attributes work to, so a reviewer can match it against
//     the author of the commit that carries the lock. That matching is the
//     whole value — it makes the claim checkable against something the repo can
//     actually enforce.
//
//  2. `user@hostname`. What Terraform records as a lock's holder, and what git
//     itself synthesizes when no identity is configured. The hostname is the
//     useful half: it names the machine to go look at. A bare OS username is
//     strictly worse — it is whoever happened to be logged in, and in CI it is
//     `runner` or `root`, which identifies nobody.
//
// Deliberately NOT a MAC address or other hardware id: modern systems randomize
// MACs by default, they differ per interface and VPN, and collecting one is
// device fingerprinting for a field that is not authentication anyway.
// ---------------------------------------------------------------------------

/** Read one git config value, or undefined when git is absent/unset/not a repo. */
function gitConfig(key: string): string | undefined {
  try {
    const value = execFileSync('git', ['config', '--get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
    return value || undefined;
  } catch {
    return undefined; // no git, no repo, or the key is unset — all "nothing to read"
  }
}

/** `user@hostname`, the fallback when no git identity is configured. */
function machineIdentity(): ApproverIdentity {
  let user = 'unknown';
  try {
    user = os.userInfo().username || user;
  } catch { /* locked-down environments can refuse; keep 'unknown' */ }
  let host = '';
  try {
    host = os.hostname();
  } catch { /* same */ }
  return { id: host ? `${user}@${host}` : user, source: 'os' };
}

/**
 * The identity to record for a lock taken on this machine.
 *
 * Never throws and never prompts: a lock must not fail because a name could not
 * be resolved. The worst case is `unknown@host` with `source: 'os'`, which is
 * still an honest statement of what is known.
 */
export function localApprover(): ApproverIdentity {
  const name = gitConfig('user.name');
  const email = gitConfig('user.email');
  if (name && email) return { id: `${name} <${email}>`, source: 'git' };
  // Half a git identity is not one. Git itself refuses to commit on a partial
  // identity rather than inventing the other half, and inventing it here would
  // mean labelling a machine-derived string as `git`.
  if (email) return { id: email, source: 'git' };
  return machineIdentity();
}
