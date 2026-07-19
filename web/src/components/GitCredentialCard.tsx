import { useState } from 'react';
import { get, post } from '../api';
import { AsyncButton, Badge, Button, Field, TextInput, useAsync, useToast } from '../ui';

/**
 * Sets the single instance-wide git bot token (`git-token`) that BOTH the backup
 * repos and the per-project backing use to authenticate HTTPS remotes (injected
 * as `x-access-token:<token>@…`). One card, reused on the Backups tab and the
 * per-project Git tab, with a built-in "exact permissions" tutorial so nobody has
 * to guess a PAT's scopes (or over-grant to be safe). The value is write-only —
 * only the key NAMES are ever listable, and the token is never mirrored into a
 * backing repo.
 */
export function GitCredentialCard() {
  const toast = useToast();
  // Listing secret refs needs instance admin; tolerate a 403 so the card still
  // renders (and can set the token) for admins whose ref list we can't read.
  const refs = useAsync<{ refs: string[] }>(
    () => get<{ refs: string[] }>('/web/admin/secrets').catch(() => ({ refs: [] as string[] })),
    [],
  );
  const [pat, setPat] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const isSet = refs.data?.refs.includes('git-token') ?? false;

  async function save() {
    await post('/web/admin/secrets', { key: 'git-token', value: pat });
    toast.ok('Git access token saved');
    setPat('');
    refs.reload();
  }

  return (
    <div className="panel">
      <h4>
        Shared git access token {isSet ? <Badge tone="ok">set</Badge> : <Badge tone="warn">not set</Badge>}
      </h4>
      <p className="hint">
        The <strong>fallback</strong> token for HTTPS git remotes: any connection (backup binding or per-project
        backing) that has no PAT of its own uses this one, injected as <code>x-access-token</code>. Give a connection
        its own PAT when it lives in a different org or account; otherwise this shared token covers it. Set once
        (requires instance admin); the value is write-only and never mirrored into any repo. Re-set to rotate.
      </p>
      <div className="row-form">
        <Field label="Personal access token">
          <TextInput type="password" value={pat} onChange={setPat} placeholder="github_pat_… / ghp_… / glpat-…" />
        </Field>
        <div className="row-form-action">
          <AsyncButton variant="primary" action={save} onError={toast.bad} disabled={!pat}>
            {isSet ? 'Rotate token' : 'Save token'}
          </AsyncButton>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => setShowHelp((h) => !h)}>
        {showHelp ? 'Hide token setup' : 'Which permissions does the token need?'}
      </Button>
      {showHelp && <TokenHelp />}
    </div>
  );
}

/** Concise PAT recipe for an inline info tip next to a per-connection PAT field.
 *  Exported so both the field tips and (via the card) the full walkthrough stay
 *  in agreement on the least-privilege scopes. */
export function GitPatSummary() {
  return (
    <>
      <p>
        <strong>Grant the least privilege — repository “Contents: Read and write”, on this repo only.</strong>
      </p>
      <ul>
        <li>
          <strong>GitHub fine-grained:</strong> Repository access → only this repo → Permissions →{' '}
          <code>Contents: Read and write</code> (Metadata is added automatically).
        </li>
        <li>
          <strong>GitHub classic:</strong> <code>repo</code> (or <code>public_repo</code> if the repo is public).
        </li>
        <li>
          <strong>GitLab:</strong> <code>write_repository</code>. <strong>Bitbucket:</strong> Repositories Read + Write.
        </li>
      </ul>
      <p>
        A brand-new empty repo is fine — wairon creates the branch on the first sync. Leave the field blank to use the
        shared fallback token instead.
      </p>
    </>
  );
}

/** The exact, least-privilege PAT recipe per provider — Contents/repo write only. */
function TokenHelp() {
  return (
    <div className="token-help">
      <p className="token-help-note">
        The token only needs to <strong>read and write repository contents</strong> (clone, commit, push). Grant
        nothing else — no admin, workflows, packages, or org scopes. A brand-new <em>empty</em> repo is fine — wairon
        creates the branch on the first sync.
      </p>

      <h5>GitHub — fine-grained token (recommended)</h5>
      <ol>
        <li>
          <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer">
            Settings → Developer settings → Fine-grained tokens
          </a>{' '}
          → <strong>Generate new token</strong>.
        </li>
        <li>
          <strong>Resource owner</strong>: the user or org that owns the backup repo.
        </li>
        <li>
          <strong>Repository access</strong>: “Only select repositories” → pick the backup repo(s).
        </li>
        <li>
          <strong>Repository permissions</strong> → <code>Contents</code>: <strong>Read and write</strong>. That is the
          only permission required. (<code>Metadata: Read-only</code> is added automatically.)
        </li>
        <li>Set an expiry, generate, and paste the <code>github_pat_…</code> value above.</li>
      </ol>

      <h5>GitHub — classic token</h5>
      <ul>
        <li>
          Scope <code>repo</code> (Full control of private repositories) for private repos, or just{' '}
          <code>public_repo</code> if the backup repo is public. No other scopes.
        </li>
      </ul>

      <h5>GitLab</h5>
      <ul>
        <li>
          Project or personal access token with scope <code>write_repository</code> (includes read), role{' '}
          <strong>Developer</strong> or above.
        </li>
      </ul>

      <h5>Bitbucket</h5>
      <ul>
        <li>
          App password with <strong>Repositories: Read</strong> + <strong>Write</strong>.
        </li>
      </ul>

      <p className="token-help-note">
        If the target branch is protected, allow this token to push to it (or back up to an unprotected branch).
      </p>
    </div>
  );
}
