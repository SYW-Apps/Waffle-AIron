import { useState } from 'react';
import { get, post } from '../api';
import {
  AsyncButton,
  AsyncView,
  Badge,
  Button,
  Checkbox,
  ConfirmButton,
  DataTable,
  Field,
  Modal,
  TextInput,
  useAsync,
  useToast,
} from '../ui';
import type { ShareAccessEntry, ShareLink, ShareLinkCreated } from '../types';

const shareUrl = (token: string) => `${window.location.origin}/share/${token}`;
const isExpired = (l: ShareLink) => !!l.expiresAt && Date.parse(l.expiresAt) <= Date.now();

/**
 * The owner-side Sharing tab: create public read-only share links for a project's
 * canvas view (a point-in-time snapshot), see their status + per-link access log,
 * and disable / refresh / revoke them. The unguessable URL is shown EXACTLY ONCE
 * at creation (only its hash is stored), so it can never be recovered later.
 */
export function SharingTab({ projectId }: { projectId: string }) {
  const toast = useToast();
  const links = useAsync<{ links: ShareLink[] }>(
    () => get(`/web/admin/share?projectId=${encodeURIComponent(projectId)}`),
    [projectId],
    ['share'],
  );
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ShareLinkCreated | null>(null);
  const [logFor, setLogFor] = useState<ShareLink | null>(null);

  async function setEnabled(link: ShareLink, enabled: boolean) {
    await post('/web/admin/share/update', { linkId: link.id, changes: { enabled } });
    toast.ok(enabled ? 'Link enabled' : 'Link disabled');
    links.reload();
  }
  async function refresh(id: string) {
    await post('/web/admin/share/refresh', { linkId: id });
    toast.ok('Snapshot refreshed');
    links.reload();
  }
  async function remove(id: string) {
    await post('/web/admin/share/remove', { linkId: id });
    toast.ok('Link revoked');
    links.reload();
  }

  return (
    <div className="stack-lg">
      <div className="view-head">
        <p className="hint">
          Public, read-only share links to this project's canvas — a point-in-time snapshot, revocable, with every
          access logged. Requires the <code>share:create</code> permission. The link is shown once on creation.
        </p>
        <Button variant="primary" onClick={() => setCreating(true)}>
          + Create share link
        </Button>
      </div>

      <AsyncView state={links}>
        {(d) => (
          <DataTable<ShareLink>
            rowKey={(l) => l.id}
            empty="No share links for this project yet."
            rows={d.links}
            columns={[
              {
                key: 'created',
                header: 'Created',
                cell: (l) => <span className="hint">{new Date(l.createdAt).toLocaleDateString()}</span>,
              },
              {
                key: 'status',
                header: 'Status',
                cell: (l) =>
                  isExpired(l) ? (
                    <Badge tone="bad">expired</Badge>
                  ) : l.enabled ? (
                    <Badge tone="ok">active</Badge>
                  ) : (
                    <Badge tone="warn">disabled</Badge>
                  ),
              },
              {
                key: 'downloads',
                header: 'Downloads',
                cell: (l) => (
                  <span className="cell-inline">
                    {l.allowDownloadHtml && <Badge tone="neutral">HTML</Badge>}
                    {l.allowDownloadOpenapi && <Badge tone="neutral">OpenAPI</Badge>}
                    {l.frameAncestors.length > 0 && <Badge tone="accent">embeddable</Badge>}
                    {!l.allowDownloadHtml && !l.allowDownloadOpenapi && l.frameAncestors.length === 0 && (
                      <span className="hint">—</span>
                    )}
                  </span>
                ),
              },
              {
                key: 'expiry',
                header: 'Expires',
                cell: (l) => <span className="hint">{l.expiresAt ? new Date(l.expiresAt).toLocaleDateString() : 'never'}</span>,
              },
              {
                key: 'act',
                header: '',
                cell: (l) => (
                  <div className="row-actions">
                    <Button size="sm" variant="ghost" onClick={() => setLogFor(l)}>
                      Access log
                    </Button>
                    <AsyncButton size="sm" action={() => refresh(l.id)} onError={toast.bad}>
                      Refresh
                    </AsyncButton>
                    {isExpired(l) ? null : l.enabled ? (
                      <AsyncButton size="sm" action={() => setEnabled(l, false)} onError={toast.bad}>
                        Disable
                      </AsyncButton>
                    ) : (
                      <AsyncButton size="sm" action={() => setEnabled(l, true)} onError={toast.bad}>
                        Enable
                      </AsyncButton>
                    )}
                    <ConfirmButton
                      label="Revoke"
                      title="Revoke share link"
                      message="Permanently revoke this link? Its URL will stop working immediately."
                      confirmLabel="Revoke"
                      action={() => remove(l.id)}
                      onError={toast.bad}
                    />
                  </div>
                ),
              },
            ]}
          />
        )}
      </AsyncView>

      {creating && (
        <CreateShareModal
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            links.reload();
          }}
        />
      )}
      {created && <TokenOnceModal created={created} onClose={() => setCreated(null)} />}
      {logFor && <AccessLogModal link={logFor} onClose={() => setLogFor(null)} />}
    </div>
  );
}

// ── Create modal ─────────────────────────────────────────────────────────────

function CreateShareModal(props: { projectId: string; onClose: () => void; onCreated: (c: ShareLinkCreated) => void }) {
  const toast = useToast();
  const [expiresAt, setExpiresAt] = useState('');
  const [allowDownloadHtml, setAllowDownloadHtml] = useState(false);
  const [allowDownloadOpenapi, setAllowDownloadOpenapi] = useState(false);
  const [frameAncestors, setFrameAncestors] = useState('');

  async function create() {
    const result = await post<ShareLinkCreated>('/web/admin/share', {
      projectId: props.projectId,
      // The shared page is the whole interactive canvas (all views + drill-down),
      // so a link is the project canvas, not a single view.
      view: 'canvas',
      mode: 'snapshot',
      artifacts: ['canvas', 'html', ...(allowDownloadOpenapi ? ['openapi'] : [])],
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      allowDownloadHtml,
      allowDownloadOpenapi,
      frameAncestors: frameAncestors.split(',').map((s) => s.trim()).filter(Boolean),
    });
    props.onCreated(result);
  }

  return (
    <Modal
      title="Create share link"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <AsyncButton variant="primary" action={create} onError={toast.bad}>
            Create
          </AsyncButton>
        </>
      }
    >
      <div className="stack-lg">
        <p className="hint">
          Shares the whole interactive project canvas (all views + drill-down) as a point-in-time snapshot.
        </p>
        <Field label="Expires (optional)" hint="Leave blank for no expiry. The link stops working after this date.">
          <TextInput type="date" value={expiresAt} onChange={setExpiresAt} />
        </Field>
        <Checkbox checked={allowDownloadHtml} onChange={setAllowDownloadHtml} label="Allow downloading the standalone HTML canvas" />
        <Checkbox
          checked={allowDownloadOpenapi}
          onChange={setAllowDownloadOpenapi}
          label="Include the OpenAPI document (viewer + download)"
          hint="Generated from the project's EXTERNAL public surface (L0 interfaces marked audience 'external'). Empty if the project publishes none."
        />
        <Field
          label="Embedding allowlist (optional)"
          info={
            <>
              <p>
                Domains permitted to embed this view in an <code>&lt;iframe&gt;</code> (CSP{' '}
                <code>frame-ancestors</code>). Comma-separated, e.g. <code>https://www.notion.so</code>. Blank = not
                embeddable anywhere.
              </p>
            </>
          }
          hint="Comma-separated origins, e.g. https://www.notion.so"
        >
          <TextInput value={frameAncestors} onChange={setFrameAncestors} placeholder="https://www.notion.so" />
        </Field>
        <p className="hint">
          The snapshot is captured now and never changes. Use <strong>Refresh</strong> later to re-capture the current
          view.
        </p>
      </div>
    </Modal>
  );
}

// ── Token-shown-once modal ────────────────────────────────────────────────────

function TokenOnceModal(props: { created: ShareLinkCreated; onClose: () => void }) {
  const toast = useToast();
  const url = shareUrl(props.created.token);
  return (
    <Modal
      title="Share link created"
      onClose={props.onClose}
      footer={
        <Button variant="primary" onClick={props.onClose}>
          Done
        </Button>
      }
    >
      <div className="stack-lg">
        <p className="hint">
          Copy this link now — it is shown <strong>once</strong> and cannot be recovered (only its hash is stored). You
          can revoke it any time.
        </p>
        <div className="row-form">
          <Field label="Share URL">
            <TextInput value={url} onChange={() => {}} />
          </Field>
          <div className="row-form-action">
            <Button
              variant="primary"
              onClick={() => {
                navigator.clipboard?.writeText(url).then(
                  () => toast.ok('Copied'),
                  () => toast.bad('Copy failed'),
                );
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Access-log modal ──────────────────────────────────────────────────────────

const OUTCOME_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  served: 'ok',
  'denied-disabled': 'warn',
  'denied-expired': 'warn',
  'denied-download': 'warn',
  'not-found': 'bad',
};

function AccessLogModal(props: { link: ShareLink; onClose: () => void }) {
  const log = useAsync<{ entries: ShareAccessEntry[] }>(
    () => get(`/web/admin/share/access?linkId=${encodeURIComponent(props.link.id)}&limit=200`),
    [props.link.id],
  );
  return (
    <Modal title="Share link access log" onClose={props.onClose} wide footer={<Button variant="primary" onClick={props.onClose}>Close</Button>}>
      <p className="hint">Every access to this link — watch for unfamiliar IPs or a burst of activity.</p>
      <AsyncView state={log}>
        {(d) => (
          <DataTable<ShareAccessEntry>
            rowKey={(e) => e.id}
            empty="No accesses recorded yet."
            rows={d.entries}
            columns={[
              { key: 'at', header: 'When', cell: (e) => <span className="hint">{new Date(e.at).toLocaleString()}</span> },
              { key: 'ip', header: 'IP', cell: (e) => <code>{e.ip}</code> },
              { key: 'outcome', header: 'Outcome', cell: (e) => <Badge tone={OUTCOME_TONE[e.outcome] ?? 'neutral'}>{e.outcome}</Badge> },
              { key: 'ua', header: 'User agent', cell: (e) => <span className="subtle" style={{ fontSize: 11 }}>{e.userAgent || '—'}</span> },
              { key: 'ref', header: 'Referer', cell: (e) => <span className="subtle" style={{ fontSize: 11 }}>{e.referer || '—'}</span> },
            ]}
          />
        )}
      </AsyncView>
    </Modal>
  );
}
