import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { asList, download, get, post, postBinary } from '../api';
import {
  AsyncButton,
  AsyncView,
  Badge,
  Button,
  ConfirmButton,
  DataTable,
  ErrorNote,
  Field,
  Modal,
  Select,
  Spinner,
  Tabs,
  TextInput,
  useAsync,
  useToast,
} from '../ui';
import { GitCredentialCard, GitPatSummary } from '../components/GitCredentialCard';
import { SharingTab } from './Sharing';
import { SpecsTab } from './SpecsEditor';
import type {
  DoctrineChange,
  GitBackingStatus,
  ImpactFinding,
  PackDescriptor,
  PackImpact,
  PolicyEvaluationResult,
  ProducerConfig,
  TreeImportResult,
} from '../types';

// ── Pack impact ──────────────────────────────────────────────────────────────
//
// What a pack write changes, measured by the host before it happens and writing
// nothing: the pack's doctrine against wairon's defaults (by the profile that
// carries each change), the profiles that would govern this project, and the
// findings that change with both totals. It states changes and never judges
// them — packs exist to adjust wairon's checks, so a loosening reads like any
// other change. Shared by the packs view (before install / adopt / remove), the
// policy view (reconcile) and the new-project dialog (what the policy applied).

const totalsLine = (v: PackImpact['before']): string => `${v.errors} errors · ${v.warnings} warnings · ${v.notices} notices`;

function DoctrineList({ changes }: { changes: DoctrineChange[] }) {
  if (changes.length === 0) return <p className="hint">No changes against wairon's defaults.</p>;
  const groups = new Map<string, DoctrineChange[]>();
  for (const c of changes) groups.set(c.profile ?? '', [...(groups.get(c.profile ?? '') ?? []), c]);
  return (
    <div className="stack-sm">
      {[...groups].map(([profile, list]) => (
        <div key={profile || '(pack-wide)'} className="cell-stack">
          <strong>{profile === '' ? 'Pack-wide' : <>Profile <code>{profile}</code></>}</strong>
          <ul className="finding-list">
            {list.map((c, i) => (
              <li key={i}>
                <Badge tone={c.axis === 'rule' ? 'neutral' : 'accent'}>{c.axis} {c.change}</Badge> <code>{c.subject}</code>
                {(c.from !== undefined || c.to !== undefined) && (
                  <span className="hint"> ({c.from ?? '—'} → {c.to ?? '—'})</span>
                )}
                {c.reason && <span className="hint"> — {c.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function FindingLine({ mark, finding, note }: { mark: string; finding: ImpactFinding; note?: string }) {
  const tone = finding.severity === 'error' ? 'bad' : finding.severity === 'warning' ? 'warn' : 'neutral';
  return (
    <li>
      <code>{mark}</code> <Badge tone={tone}>{finding.severity}</Badge> <code>{finding.code}</code>
      {finding.specId && <span className="subtle"> {finding.specId}</span>} {note ? <span className="hint">{note}</span> : finding.message}
    </li>
  );
}

/** The full impact report of one pack write. */
export function PackImpactReport({ impact }: { impact: PackImpact }) {
  const removal = impact.direction === 'remove';
  const f = impact.findings;
  return (
    <div className="stack-lg">
      <div className="cell-stack">
        <strong>
          {impact.pack}
          {impact.version ? ` v${impact.version}` : ''}
          {impact.replaces ? ` (replaces v${impact.replaces})` : ''}
        </strong>
        <span className="hint">
          {removal
            ? 'Measured as removed: the findings are what the pack accounts for on this project now.'
            : 'Measured as applied. Nothing has been written. Changes are stated, never judged.'}
        </span>
      </div>
      <div className="panel">
        <h4>What it changes against wairon's defaults</h4>
        <DoctrineList changes={impact.doctrine} />
        {impact.previousDoctrine && (
          <details>
            <summary className="hint">What the replaced version{impact.replaces ? ` v${impact.replaces}` : ''} changed</summary>
            <DoctrineList changes={impact.previousDoctrine} />
          </details>
        )}
      </div>
      <dl className="kv">
        <dt>Governs here</dt>
        <dd>{impact.governing.length > 0 ? impact.governing.map((p) => <code key={p}>{p} </code>) : <span className="hint">none of its profiles</span>}</dd>
        <dt>Before</dt>
        <dd>{totalsLine(impact.before)}</dd>
        <dt>After</dt>
        <dd>{totalsLine(impact.after)}</dd>
      </dl>
      <div className="panel">
        <h4>
          Findings on this project{removal ? ' once it no longer applies' : ''}: {f.introduced.length} introduced, {f.resolved.length} resolved,{' '}
          {f.regraded.length} regraded
        </h4>
        {f.introduced.length + f.resolved.length + f.regraded.length === 0 ? (
          <p className="hint">No finding changes.</p>
        ) : (
          <ul className="finding-list">
            {f.introduced.map((i, k) => <FindingLine key={`i${k}`} mark="+" finding={i} />)}
            {f.resolved.map((i, k) => <FindingLine key={`r${k}`} mark="−" finding={i} />)}
            {f.regraded.map((r, k) => <FindingLine key={`g${k}`} mark="~" finding={r.finding} note={`was ${r.from}`} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One impact in a line, expandable to the full report. */
export function PackImpactSummary({ impact }: { impact: PackImpact }) {
  const f = impact.findings;
  return (
    <details className="panel">
      <summary>
        <strong>{impact.pack}{impact.version ? ` v${impact.version}` : ''}</strong>
        <span className="hint">
          {' '}— {impact.doctrine.length} doctrine change(s); findings {f.introduced.length} introduced, {f.resolved.length} resolved,{' '}
          {f.regraded.length} regraded; {totalsLine(impact.before)} → {totalsLine(impact.after)}
        </span>
      </summary>
      <PackImpactReport impact={impact} />
    </details>
  );
}

/**
 * The confirm step every pack write goes through: the impact is measured first
 * (`measure`), shown, and the write (`apply`) runs only when the user confirms.
 * Cancelling writes nothing. With no `measure` the impact is unavailable, which
 * the dialog says plainly — and it still asks.
 */
function PackWriteConfirm(props: {
  title: string;
  confirmLabel: string;
  measure?: () => Promise<PackImpact>;
  unavailable?: string;
  apply: () => Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [impact, setImpact] = useState<PackImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { measure } = props;
  useEffect(() => {
    if (!measure) return;
    let live = true;
    setImpact(null);
    setError(null);
    measure()
      .then((d) => live && setImpact(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  const ready = !measure || impact !== null;
  return (
    <Modal
      title={props.title}
      wide
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <AsyncButton
            variant="primary"
            disabled={!ready}
            onError={props.onError}
            action={async () => {
              await props.apply();
              props.onClose();
            }}
          >
            {props.confirmLabel}
          </AsyncButton>
        </>
      }
    >
      {!measure ? (
        <p className="hint">{props.unavailable ?? 'Impact not available for this write.'}</p>
      ) : error ? (
        <ErrorNote onRetry={() => setAttempt((n) => n + 1)}>Could not measure the impact: {error}. Nothing was written.</ErrorNote>
      ) : impact ? (
        <PackImpactReport impact={impact} />
      ) : (
        <div className="pad">
          <Spinner /> <span className="hint">Measuring what this would change…</span>
        </div>
      )}
    </Modal>
  );
}

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
  const [yamlOpen, setYamlOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [nameOverride, setNameOverride] = useState('');
  const [yamlName, setYamlName] = useState('');
  const [yamlContent, setYamlContent] = useState('');
  // The pending pack write: its impact is shown first and it runs only on confirm.
  const [confirm, setConfirm] = useState<{
    title: string;
    confirmLabel: string;
    measure?: () => Promise<PackImpact>;
    unavailable?: string;
    apply: () => Promise<void>;
  } | null>(null);

  // Adoptable minus what's already installed here (match by name).
  const installedNames = new Set((packs.data ?? []).map((p) => p.name));
  const available = (adoptable.data ?? []).filter((p) => !installedNames.has(p.name));

  function refresh() {
    packs.reload();
    adoptable.reload();
  }

  // Adopt: the impact of adopting the server-global pack first (no content).
  function adopt(name: string) {
    setAdoptOpen(false);
    setConfirm({
      title: `Adopt “${name}” into ${projectId}?`,
      confirmLabel: 'Adopt',
      measure: () => post<PackImpact>('/web/projects/packs/impact', { projectId, name }),
      apply: async () => {
        await post('/web/projects/packs/adopt', { projectId, name });
        toast.ok(`Added “${name}”`);
        refresh();
      },
    });
  }
  // Install from YAML: the impact of exactly this content first.
  function installYaml() {
    const name = yamlName.trim();
    const content = yamlContent;
    setConfirm({
      title: `Install “${name}” into ${projectId}?`,
      confirmLabel: 'Install',
      measure: () => post<PackImpact>('/web/projects/packs/impact', { projectId, name, content }),
      apply: async () => {
        const d = await post<PackDescriptor>('/web/projects/packs', { projectId, name, content });
        toast.ok(`Installed pack “${d.name}”`);
        setYamlOpen(false);
        setYamlName('');
        setYamlContent('');
        refresh();
      },
    });
  }
  // Archive install: no preview exists for an archive — the dialog says so, and still asks.
  function installArchive() {
    const chosen = file;
    if (!chosen) return;
    setConfirm({
      title: `Install ${chosen.name} into ${projectId}?`,
      confirmLabel: 'Install',
      unavailable: 'Impact not available for an archive; install its YAML or adopt it from the catalog to preview.',
      apply: async () => {
        const headers: Record<string, string> = nameOverride.trim() ? { 'X-Wairon-Pack-Name': nameOverride.trim() } : {};
        const d = await postBinary<PackDescriptor>(`/web/projects/packs/upload?projectId=${enc}`, chosen, headers);
        toast.ok(`Installed pack “${d.name}”`);
        setUploadOpen(false);
        setFile(null);
        setNameOverride('');
        refresh();
      },
    });
  }
  // Remove: what the pack accounts for now, first.
  function remove(n: string) {
    setConfirm({
      title: `Remove “${n}” from ${projectId}?`,
      confirmLabel: 'Remove',
      measure: () => post<PackImpact>('/web/projects/packs/removal-impact', { projectId, name: n }),
      apply: async () => {
        await post('/web/projects/packs/remove', { projectId, name: n });
        toast.ok('Pack removed');
        refresh();
      },
    });
  }

  return (
    <div className="stack-lg">
      <div className="view-head">
        <p className="hint">Declarative extension packs registered on this project. Every install, adoption and removal shows what it would change first.</p>
        <div className="row-actions">
          <Button variant="ghost" onClick={() => setUploadOpen(true)} title="Upload a .wpack archive">
            Advanced: upload .wpack
          </Button>
          <Button variant="ghost" onClick={() => setYamlOpen(true)} title="Install a declarative pack from its YAML">
            Install from YAML
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
                    <Button size="sm" variant="ghost" onClick={() => remove(p.name)}>
                      Remove
                    </Button>
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
                        <Button size="sm" variant="primary" onClick={() => adopt(p.name)}>
                          Add…
                        </Button>
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
              <Button variant="primary" onClick={installArchive} disabled={!file}>
                Install…
              </Button>
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
      {yamlOpen && (
        <Modal
          title="Install a pack from YAML"
          wide
          onClose={() => setYamlOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setYamlOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={installYaml} disabled={!yamlName.trim() || !yamlContent.trim()}>
                Preview impact…
              </Button>
            </>
          }
        >
          <div className="stack-lg">
            <p className="hint">
              A declarative pack (profiles, language and platform tables, assertions). You will see what it changes on this project
              before anything is written.
            </p>
            <Field label="Pack name" hint="Letters, digits, dot, underscore, hyphen — the file it is vendored as.">
              <TextInput value={yamlName} onChange={setYamlName} placeholder="my-org-conventions" />
            </Field>
            <Field label="Pack YAML">
              <textarea className="input" rows={12} value={yamlContent} onChange={(e) => setYamlContent(e.target.value)} placeholder={'name: my-org-conventions\nprofiles:\n  backend:\n    rules: {}'} />
            </Field>
          </div>
        </Modal>
      )}
      {confirm && (
        <PackWriteConfirm
          key={confirm.title}
          title={confirm.title}
          confirmLabel={confirm.confirmLabel}
          measure={confirm.measure}
          unavailable={confirm.unavailable}
          apply={confirm.apply}
          onClose={() => setConfirm(null)}
          onError={toast.bad}
        />
      )}
    </div>
  );
}

// ── Policy ───────────────────────────────────────────────────────────────────

function PolicyTab({ projectId }: { projectId: string }) {
  const toast = useToast();
  const policy = useAsync<PolicyEvaluationResult>(() => get(`/web/projects/policy?projectId=${encodeURIComponent(projectId)}`), [projectId]);
  // What the last reconcile applied, measured before each write. A reconcile is a
  // policy write the user triggers but does not choose the packs of: the view shows
  // what it would apply beside the button, and afterwards what it did apply.
  const [applied, setApplied] = useState<PolicyEvaluationResult | null>(null);

  async function reconcile() {
    const result = await post<PolicyEvaluationResult>('/web/projects/policy/reconcile', { projectId });
    setApplied(result);
    toast.ok(result.impacts && result.impacts.length > 0 ? `Reconciled — applied ${result.impacts.length} pack(s)` : 'Reconciled to policy');
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
          {d.impacts && d.impacts.length > 0 && (
            <div className="panel">
              <h4>Reconcile would apply</h4>
              <p className="hint">
                The instance policy's required and default packs this project does not have yet, each measured against the project as it
                stands. Nothing has been written.
              </p>
              <div className="stack-sm">
                {d.impacts.map((impact) => (
                  <PackImpactSummary key={impact.pack} impact={impact} />
                ))}
              </div>
            </div>
          )}
          {applied && (
            <div className="panel">
              <h4>Last reconcile applied</h4>
              {applied.impacts && applied.impacts.length > 0 ? (
                <div className="stack-sm">
                  {applied.impacts.map((impact) => (
                    <PackImpactSummary key={impact.pack} impact={impact} />
                  ))}
                </div>
              ) : (
                <p className="hint">No pack — the project already had every pack the policy requires.</p>
              )}
            </div>
          )}
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

// ── Transfer (.waitree spec-tree migration) ──────────────────────────────────

function TransferTab({ projectId }: { projectId: string }) {
  const toast = useToast();
  const enc = encodeURIComponent(projectId);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [includeDerived, setIncludeDerived] = useState(false);
  const [last, setLast] = useState<TreeImportResult | null>(null);

  async function exportTree() {
    await download(
      `/web/projects/tree/export?projectId=${enc}${includeDerived ? '&includeDerived=1' : ''}`,
      `${projectId}.waitree`,
    );
    toast.ok('Spec tree exported');
  }

  async function importTree() {
    if (!file) return;
    const d = await postBinary<TreeImportResult>(
      `/web/projects/tree/import?projectId=${enc}${replace ? '&replace=1' : ''}`,
      file,
    );
    setLast(d);
    setFile(null);
    toast.ok(`Imported “${d.projectName}” — ${d.fileCount} file(s)`);
  }

  return (
    <div className="stack-lg">
      <p className="hint">
        Move this project's whole spec tree — its own <code>.wai/</code> plus every chained subproject — as a single
        <code> .waitree</code> archive. This is the migration path between a local checkout and this instance.
      </p>

      <div className="panel">
        <h4>Export</h4>
        <p className="hint">
          Downloads the authored design: specs, lock, rules, variants, surfaces and packs. Regenerable artifacts
          (diagrams, generated topology) are rebuilt at the destination and left out by default.
        </p>
        <label className="toggle-row">
          <input type="checkbox" checked={includeDerived} onChange={(e) => setIncludeDerived(e.target.checked)} />
          <span className="cell-stack">
            <strong>Include generated artifacts</strong>
            <span className="hint">A larger archive; rarely needed, since the destination regenerates them.</span>
          </span>
        </label>
        <div className="row-actions">
          <AsyncButton variant="primary" action={exportTree} onError={toast.bad}>
            Download .waitree
          </AsyncButton>
        </div>
      </div>

      <div className="panel">
        <h4>Import</h4>
        <p className="hint">
          Replaces this project's spec tree from an archive. Requires <code>project:admin</code>. Executable content is
          always refused, and the previous tree is moved aside to a backup you can restore by hand.
        </p>
        <Field label="Spec-tree archive (.waitree)" hint="Produced by an export here, or by `wairon remote pull`.">
          <input
            className="input"
            type="file"
            accept=".waitree,.zip,application/zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <label className="toggle-row">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          <span className="cell-stack">
            <strong>Replace the existing spec tree</strong>
            <span className="hint">
              Required once this project holds authored specs — a freshly created project imports without it.
            </span>
          </span>
        </label>
        <div className="row-actions">
          <AsyncButton variant="primary" action={importTree} onError={toast.bad} disabled={!file}>
            Import archive
          </AsyncButton>
        </div>
        {last && (
          <dl className="kv">
            <dt>Imported</dt>
            <dd>
              <strong>{last.projectName}</strong> — {last.fileCount} file(s)
            </dd>
            <dt>Roots</dt>
            <dd>
              {last.roots.map((r) => (
                <code key={r} className="subtle">{r} </code>
              ))}
            </dd>
            <dt>Previous tree</dt>
            <dd>
              {last.backupPath ? <code className="subtle">{last.backupPath}</code> : <span className="hint">none — the project was empty</span>}
            </dd>
          </dl>
        )}
      </div>
    </div>
  );
}

// ── Ops shell ────────────────────────────────────────────────────────────────

const OPS_TABS = [
  { id: 'specs', label: 'Specs' },
  { id: 'packs', label: 'Packs' },
  { id: 'policy', label: 'Policy' },
  { id: 'producers', label: 'Producers' },
  { id: 'git', label: 'Git' },
  { id: 'transfer', label: 'Transfer' },
  { id: 'sharing', label: 'Sharing' },
];

export function ProjectOps() {
  const params = useParams();
  const projectId = params.projectId ?? '';
  const splat = params['*'] ?? '';
  const nav = useNavigate();
  const base = `/projects/${encodeURIComponent(projectId)}`;

  // The tab (and, on Specs, the open spec) live in the URL path so a view is
  // shareable and the canvas can deep-link into it. `/projects/<id>` → Specs;
  // `/projects/<id>/<tab>`; `/projects/<id>/specs/<kind>/<id…>` opens a spec,
  // the qualified id's `::` mapped to `/` path segments (so no %3A).
  const segs = splat.split('/').filter(Boolean);
  const tab = segs[0] && OPS_TABS.some((t) => t.id === segs[0]) ? segs[0] : 'specs';
  const selection = useMemo(() => {
    if (tab !== 'specs' || segs.length < 3) return null;
    return { kind: segs[1], id: segs.slice(2).map(decodeURIComponent).join('::') };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splat]);

  const selectTab = (id: string) => nav(id === 'specs' ? `${base}/specs` : `${base}/${id}`);
  const selectSpec = (sel: { kind: string; id: string } | null) => {
    if (!sel) return nav(`${base}/specs`);
    const idPath = sel.id.split('::').map(encodeURIComponent).join('/');
    nav(`${base}/specs/${sel.kind}/${idPath}`);
  };

  return (
    <div className={`view-pad ${tab === 'specs' ? 'view-pad-wide' : ''}`}>
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
      <Tabs tabs={OPS_TABS} active={tab} onSelect={selectTab} />
      <div className="tab-panel">
        {tab === 'specs' && <SpecsTab projectId={projectId} selection={selection} onSelectSpec={selectSpec} />}
        {tab === 'packs' && <PacksTab projectId={projectId} />}
        {tab === 'policy' && <PolicyTab projectId={projectId} />}
        {tab === 'producers' && <ProducersTab projectId={projectId} />}
        {tab === 'git' && <GitTab projectId={projectId} />}
        {tab === 'transfer' && <TransferTab projectId={projectId} />}
        {tab === 'sharing' && <SharingTab projectId={projectId} />}
      </div>
    </div>
  );
}
