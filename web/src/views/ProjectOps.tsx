import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { asList, get, post, postBinary } from '../api';
import {
  AsyncButton,
  AsyncView,
  Badge,
  Button,
  ConfirmButton,
  DataTable,
  Field,
  Modal,
  Select,
  Tabs,
  TextInput,
  useAsync,
  useToast,
} from '../ui';
import { GitCredentialCard, GitPatSummary } from '../components/GitCredentialCard';
import { SharingTab } from './Sharing';
import type { GitBackingStatus, PackDescriptor, PolicyEvaluationResult, ProducerConfig } from '../types';

// ── Packs ────────────────────────────────────────────────────────────────────

// Contents counts prefer the enriched id arrays, falling back to numeric counts.
const packProfileCount = (p: PackDescriptor): number => p.profileIds?.length ?? p.profiles ?? 0;
const packLanguageCount = (p: PackDescriptor): number => p.languageIds?.length ?? p.languages ?? 0;
const packRuleCount = (p: PackDescriptor): number => p.ruleIds?.length ?? p.rules ?? 0;
const packContentsHint = (p: PackDescriptor): string =>
  `${packProfileCount(p)} profiles · ${packLanguageCount(p)} langs · ${packRuleCount(p)} rules`;

function PacksTab({ projectId }: { projectId: string }) {
  const toast = useToast();
  const enc = encodeURIComponent(projectId);
  const packs = useAsync<PackDescriptor[]>(
    () => get(`/web/projects/packs?projectId=${enc}`).then((d) => asList<PackDescriptor>(d, 'packs')),
    [projectId],
  );
  // The server-global catalog this project may adopt without an upload.
  const adoptable = useAsync<PackDescriptor[]>(
    () => get(`/web/projects/packs/adoptable?projectId=${enc}`).then((d) => asList<PackDescriptor>(d, 'packs')),
    [projectId],
  );
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [nameOverride, setNameOverride] = useState('');

  // Adoptable minus what's already installed here (match by name).
  const installedNames = new Set((packs.data ?? []).map((p) => p.name));
  const available = (adoptable.data ?? []).filter((p) => !installedNames.has(p.name));

  async function adopt(name: string) {
    await post('/web/projects/packs/adopt', { projectId, name });
    toast.ok(`Added “${name}”`);
    packs.reload();
    adoptable.reload();
  }
  async function install() {
    if (!file) return;
    const headers: Record<string, string> = nameOverride.trim() ? { 'X-Wairon-Pack-Name': nameOverride.trim() } : {};
    const d = await postBinary<PackDescriptor>(
      `/web/projects/packs/upload?projectId=${enc}`,
      file,
      headers,
    );
    toast.ok(`Installed pack “${d.name}”`);
    setUploadOpen(false);
    setFile(null);
    setNameOverride('');
    packs.reload();
    adoptable.reload();
  }
  async function remove(n: string) {
    await post('/web/projects/packs/remove', { projectId, name: n });
    toast.ok('Pack removed');
    packs.reload();
    adoptable.reload();
  }

  return (
    <div className="stack-lg">
      <div className="view-head">
        <p className="hint">Declarative extension packs registered on this project.</p>
        <div className="row-actions">
          <Button variant="ghost" onClick={() => setUploadOpen(true)} title="Upload a .wpack archive">
            Advanced: upload .wpack
          </Button>
          <Button variant="primary" onClick={() => setAdoptOpen(true)}>
            + Add from available
          </Button>
        </div>
      </div>
      <AsyncView state={packs}>
        {(d) => (
          <DataTable<PackDescriptor>
            rowKey={(p) => p.name}
            empty={
              <div className="cell-stack">
                <span>No packs installed on this project.</span>
                <span className="hint">Use “Add from available” to adopt a server-global pack, or upload a .wpack.</span>
              </div>
            }
            rows={d}
            columns={[
              {
                key: 'name',
                header: 'Pack',
                cell: (p) => (
                  <div className="cell-stack">
                    <strong>{p.name}</strong>
                    <code className="subtle">{p.ref}</code>
                    {p.error && <span className="err">{p.error}</span>}
                  </div>
                ),
              },
              { key: 'scope', header: 'Scope', cell: (p) => <Badge tone={p.scope === 'global' ? 'accent' : 'neutral'}>{p.tier ?? p.scope}</Badge> },
              { key: 'counts', header: 'Contents', cell: (p) => <span className="hint">{packContentsHint(p)}</span> },
              {
                key: 'act',
                header: '',
                width: '1%',
                cell: (p) =>
                  p.scope === 'project' ? (
                    <AsyncButton size="sm" variant="ghost" action={() => remove(p.name)} onError={toast.bad}>
                      Remove
                    </AsyncButton>
                  ) : (
                    <span className="hint">inherited</span>
                  ),
              },
            ]}
          />
        )}
      </AsyncView>
      {adoptOpen && (
        <Modal
          title="Add a pack from the catalog"
          wide
          onClose={() => setAdoptOpen(false)}
          footer={<Button variant="ghost" onClick={() => setAdoptOpen(false)}>Done</Button>}
        >
          <div className="stack-lg">
            <p className="hint">Server-global packs this project can adopt directly — no upload needed.</p>
            <AsyncView state={adoptable}>
              {() => (
                <DataTable<PackDescriptor>
                  rowKey={(p) => p.name}
                  empty="No more packs available to adopt."
                  rows={available}
                  columns={[
                    {
                      key: 'name',
                      header: 'Pack',
                      cell: (p) => (
                        <div className="cell-stack">
                          <strong>{p.name}</strong>
                          <code className="subtle">{p.ref}</code>
                        </div>
                      ),
                    },
                    { key: 'tier', header: 'Tier', cell: (p) => <Badge tone={p.scope === 'global' ? 'accent' : 'neutral'}>{p.tier ?? p.scope}</Badge> },
                    { key: 'counts', header: 'Contents', cell: (p) => <span className="hint">{packContentsHint(p)}</span> },
                    {
                      key: 'act',
                      header: '',
                      width: '1%',
                      cell: (p) => (
                        <AsyncButton size="sm" variant="primary" action={() => adopt(p.name)} onError={toast.bad}>
                          Add
                        </AsyncButton>
                      ),
                    },
                  ]}
                />
              )}
            </AsyncView>
          </div>
        </Modal>
      )}
      {uploadOpen && (
        <Modal
          title="Advanced: upload a .wpack"
          onClose={() => setUploadOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setUploadOpen(false)}>
                Cancel
              </Button>
              <AsyncButton variant="primary" action={install} onError={toast.bad} disabled={!file}>
                Install
              </AsyncButton>
            </>
          }
        >
          <div className="stack-lg">
            <p className="hint">Prefer “Add from available” for catalog packs. Upload is for a pack not yet on this server.</p>
            <Field label="Pack archive (.wpack)" hint="Declarative packs only — code packs are installed via the filesystem tier.">
              <input className="input" type="file" accept=".wpack,.zip,application/zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label="Name override (optional)" hint="Defaults to the pack name in the archive's manifest.">
              <TextInput value={nameOverride} onChange={setNameOverride} placeholder="my-org-conventions" />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Policy ───────────────────────────────────────────────────────────────────

function PolicyTab({ projectId }: { projectId: string }) {
  const toast = useToast();
  const policy = useAsync<PolicyEvaluationResult>(() => get(`/web/projects/policy?projectId=${encodeURIComponent(projectId)}`), [projectId]);

  async function reconcile() {
    await post('/web/projects/policy/reconcile', { projectId });
    toast.ok('Reconciled to policy');
    policy.reload();
  }

  return (
    <AsyncView state={policy}>
      {(d) => (
        <div className="stack-lg">
          <div className="view-head">
            <div className="cell-stack">
              <div>
                {d.compliant ? <Badge tone="ok">compliant</Badge> : <Badge tone="bad">non-compliant</Badge>}
                <span className="hint">&nbsp;· mode: {d.mode}</span>
              </div>
            </div>
            <AsyncButton variant="primary" action={reconcile} onError={toast.bad}>
              Reconcile to policy
            </AsyncButton>
          </div>
          {d.messages.length > 0 ? (
            <div className="panel">
              <h4>Findings</h4>
              <ul className="finding-list">
                {d.messages.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="empty-state">No policy findings — this project matches its pack/profile policy.</div>
          )}
          {(d.missingPackNames.length > 0 || d.blockedPackNames.length > 0 || d.missingProfileIds.length > 0) && (
            <div className="chip-row">
              {d.missingPackNames.map((n) => (
                <Badge key={`m${n}`} tone="warn">missing pack: {n}</Badge>
              ))}
              {d.blockedPackNames.map((n) => (
                <Badge key={`b${n}`} tone="bad">blocked pack: {n}</Badge>
              ))}
              {d.missingProfileIds.map((n) => (
                <Badge key={`p${n}`} tone="warn">missing profile: {n}</Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </AsyncView>
  );
}

// ── Producers ────────────────────────────────────────────────────────────────

function ProducersTab({ projectId }: { projectId: string }) {
  const toast = useToast();
  const producers = useAsync<{ producers: ProducerConfig[] }>(() => get(`/web/projects/producers?projectId=${encodeURIComponent(projectId)}`), [projectId]);
  const [target, setTarget] = useState('notion');
  const [parentPageId, setParentPageId] = useState('');

  async function configure() {
    await post('/web/projects/producers', { projectId, target, parentPageId });
    toast.ok(`Configured ${target}`);
    setParentPageId('');
    producers.reload();
  }
  async function run(t: string) {
    await post('/web/projects/producers/run', { projectId, target: t });
    toast.ok(`Published to ${t}`);
  }
  async function remove(t: string) {
    await post('/web/projects/producers/remove', { projectId, target: t });
    toast.ok('Producer removed');
    producers.reload();
  }

  return (
    <div className="stack-lg">
      <p className="hint">One-way projections of this project's spec tree into external docs (Notion, Miro).</p>
      <AsyncView state={producers}>
        {(d) => (
          <DataTable<ProducerConfig>
            rowKey={(p) => p.target}
            empty="No producers configured."
            rows={d.producers}
            columns={[
              { key: 'target', header: 'Target', cell: (p) => <strong>{p.target}</strong> },
              { key: 'page', header: 'Parent page', cell: (p) => <code className="subtle">{p.parentPageId}</code> },
              {
                key: 'act',
                header: '',
                cell: (p) => (
                  <div className="row-actions">
                    <AsyncButton size="sm" action={() => run(p.target)} onError={toast.bad}>
                      Publish now
                    </AsyncButton>
                    <AsyncButton size="sm" variant="ghost" action={() => remove(p.target)} onError={toast.bad}>
                      Remove
                    </AsyncButton>
                  </div>
                ),
              },
            ]}
          />
        )}
      </AsyncView>
      <div className="panel">
        <h4>Configure a producer</h4>
        <div className="row-form">
          <Field label="Target">
            <Select value={target} onChange={setTarget} options={[{ value: 'notion', label: 'Notion' }, { value: 'miro', label: 'Miro' }]} />
          </Field>
          <Field label="Parent page / board id">
            <TextInput value={parentPageId} onChange={setParentPageId} placeholder="notion page id" />
          </Field>
          <div className="row-form-action">
            <AsyncButton variant="primary" action={configure} onError={toast.bad} disabled={!parentPageId}>
              Save
            </AsyncButton>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Git ──────────────────────────────────────────────────────────────────────

function GitTab({ projectId }: { projectId: string }) {
  const toast = useToast();
  const status = useAsync<GitBackingStatus>(() => get(`/web/projects/git?projectId=${encodeURIComponent(projectId)}`), [projectId]);
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('main');
  const [pat, setPat] = useState('');
  const [message, setMessage] = useState('');

  async function bind() {
    await post('/web/projects/git', { projectId, remote, branch, pat: pat.trim() || undefined });
    toast.ok('Git backing enabled');
    setPat('');
    status.reload();
  }
  async function disconnect() {
    await post('/web/projects/git/disconnect', { projectId });
    toast.ok('Git backing disabled');
    status.reload();
  }
  async function commit() {
    await post('/web/projects/git/commit', { projectId, message: message || undefined });
    toast.ok('Committed & pushed .wai/');
    setMessage('');
    status.reload();
  }

  return (
    <AsyncView state={status}>
      {(s) => (
        <div className="stack-lg">
          <GitCredentialCard />

          {s.enabled ? (
            <div className="panel">
              <h4>
                Backing repository <Badge tone="ok">enabled</Badge> {s.dirty && <Badge tone="warn">.wai/ dirty</Badge>}{' '}
                {s.credentialRef ? <Badge tone="ok">own PAT</Badge> : <Badge tone="neutral">shared token</Badge>}
              </h4>
              <dl className="kv">
                <dt>Remote</dt>
                <dd><code>{s.remote}</code></dd>
                <dt>Branch</dt>
                <dd><code>{s.branch}</code>{s.workingBranch && s.workingBranch !== s.branch ? <> (working: <code>{s.workingBranch}</code>)</> : null}</dd>
                <dt>Last sync</dt>
                <dd>{s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : <span className="hint">never</span>}</dd>
                <dt>Periodic</dt>
                <dd>{s.periodicSyncMinutes ? `every ${s.periodicSyncMinutes} min${s.skipIfClean === false ? '' : ' (skip if clean)'}` : <span className="hint">off</span>}</dd>
              </dl>
              <p className="hint">wairon only ever stages the <code>.wai/</code> tree — never <code>git add -A</code> — so this repo is safe to share with the project's own code.</p>
              <div className="row-form">
                <Field label="Commit message (optional)">
                  <TextInput value={message} onChange={setMessage} placeholder="Update specs" />
                </Field>
                <div className="row-form-action">
                  <AsyncButton variant="primary" action={commit} onError={toast.bad}>
                    Commit & push .wai/
                  </AsyncButton>
                </div>
              </div>
              <div className="row-actions">
                <ConfirmButton
                  label="Disconnect"
                  title="Disconnect git backing"
                  message="Stop backing this project's .wai/ to git? The remote repository is left untouched."
                  confirmLabel="Disconnect"
                  action={disconnect}
                  onError={toast.bad}
                />
              </div>
            </div>
          ) : (
            <div className="panel">
              <h4>Bind the project repository</h4>
              <p className="hint">wairon manages only the <code>.wai/</code> tree inside your existing repository.</p>
              <div className="row-form">
                <Field label="Remote URL">
                  <TextInput value={remote} onChange={setRemote} placeholder="https://github.com/org/repo.git" />
                </Field>
                <Field label="Branch">
                  <TextInput value={branch} onChange={setBranch} placeholder="main" />
                </Field>
                <Field
                  label="Access token (optional)"
                  info={<GitPatSummary />}
                  hint="A PAT for this repo's org/account. Leave blank to use the shared fallback token. Stored write-only."
                >
                  <TextInput type="password" value={pat} onChange={setPat} placeholder="github_pat_… / glpat-…" />
                </Field>
                <div className="row-form-action">
                  <AsyncButton variant="primary" action={bind} onError={toast.bad} disabled={!remote}>
                    Enable git backing
                  </AsyncButton>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </AsyncView>
  );
}

// ── Ops shell ────────────────────────────────────────────────────────────────

const OPS_TABS = [
  { id: 'packs', label: 'Packs' },
  { id: 'policy', label: 'Policy' },
  { id: 'producers', label: 'Producers' },
  { id: 'git', label: 'Git' },
  { id: 'sharing', label: 'Sharing' },
];

export function ProjectOps() {
  const { projectId = '' } = useParams();
  const nav = useNavigate();
  const [tab, setTab] = useState('packs');

  return (
    <div className="view-pad">
      <div className="view-head">
        <div className="cell-stack">
          <button className="btn btn-ghost btn-sm back-link" onClick={() => nav('/projects')}>
            ← Projects
          </button>
          <h2>{projectId} · operations</h2>
        </div>
        <Button variant="ghost" onClick={() => nav(`/canvas/${encodeURIComponent(projectId)}`)}>
          Open canvas
        </Button>
      </div>
      <Tabs tabs={OPS_TABS} active={tab} onSelect={setTab} />
      <div className="tab-panel">
        {tab === 'packs' && <PacksTab projectId={projectId} />}
        {tab === 'policy' && <PolicyTab projectId={projectId} />}
        {tab === 'producers' && <ProducersTab projectId={projectId} />}
        {tab === 'git' && <GitTab projectId={projectId} />}
        {tab === 'sharing' && <SharingTab projectId={projectId} />}
      </div>
    </div>
  );
}
