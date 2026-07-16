import { useState } from 'react';
import { get, post } from '../api';
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
import type { GitBackingBinding, HostExposurePolicy, InstancePackPolicy, PackDescriptor } from '../types';

const csvToList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const listToCsv = (l?: string[]): string => (l ?? []).join(', ');

// ── Global packs ─────────────────────────────────────────────────────────────

function GlobalPacksTab() {
  const toast = useToast();
  const packs = useAsync<{ packs: PackDescriptor[] }>(() => get('/web/admin/packs'), []);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');

  async function install() {
    await post('/web/admin/packs', { name, content });
    toast.ok(`Installed “${name}”`);
    setAdding(false);
    setName('');
    setContent('');
    packs.reload();
  }
  async function remove(n: string) {
    await post('/web/admin/packs/remove', { name: n });
    toast.ok('Pack removed');
    packs.reload();
  }

  return (
    <div className="stack-lg">
      <div className="view-head">
        <p className="hint">Instance-tier declarative packs, available to every project.</p>
        <Button variant="primary" onClick={() => setAdding(true)}>
          + Install pack
        </Button>
      </div>
      <AsyncView state={packs}>
        {(d) => (
          <DataTable<PackDescriptor>
            rowKey={(p) => p.name}
            empty="No instance packs installed."
            rows={d.packs}
            columns={[
              { key: 'name', header: 'Pack', cell: (p) => <div className="cell-stack"><strong>{p.name}</strong><code className="subtle">{p.ref}</code></div> },
              { key: 'tier', header: 'Tier', cell: (p) => <Badge tone={p.tier === 'image' ? 'accent' : 'neutral'}>{p.tier ?? 'instance'}</Badge> },
              { key: 'counts', header: 'Contents', cell: (p) => <span className="hint">{p.profiles}p · {p.languages}l · {p.rules}r</span> },
              {
                key: 'act',
                header: '',
                width: '1%',
                cell: (p) =>
                  p.tier === 'image' ? (
                    <span className="hint">baked in</span>
                  ) : (
                    <AsyncButton size="sm" variant="ghost" action={() => remove(p.name)} onError={toast.bad}>
                      Remove
                    </AsyncButton>
                  ),
              },
            ]}
          />
        )}
      </AsyncView>
      {adding && (
        <Modal
          title="Install an instance pack"
          onClose={() => setAdding(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <AsyncButton variant="primary" action={install} onError={toast.bad} disabled={!name || !content}>Install</AsyncButton>
            </>
          }
        >
          <div className="stack-lg">
            <Field label="Pack name"><TextInput value={name} onChange={setName} /></Field>
            <Field label="Manifest (YAML/JSON)"><textarea className="input" rows={10} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Policy ───────────────────────────────────────────────────────────────────

function PolicyTab() {
  const toast = useToast();
  const policy = useAsync<InstancePackPolicy>(() => get('/web/admin/policy'), []);
  return (
    <AsyncView state={policy}>
      {(p) => <PolicyForm policy={p} onSaved={policy.reload} onError={toast.bad} onOk={toast.ok} />}
    </AsyncView>
  );
}

function PolicyForm(props: { policy: InstancePackPolicy; onSaved: () => void; onError: (m: string) => void; onOk: (m: string) => void }) {
  const [required, setRequired] = useState(listToCsv(props.policy.requiredGlobalPacks));
  const [defaults, setDefaults] = useState(listToCsv(props.policy.defaultProjectPacks));
  const [blocked, setBlocked] = useState(listToCsv(props.policy.blockedPackNames));
  const [mode, setMode] = useState(props.policy.enforcementMode || 'warn');
  const [requireProfile, setRequireProfile] = useState(props.policy.requireProfileSelection);

  async function save() {
    const next: InstancePackPolicy = {
      ...props.policy,
      requiredGlobalPacks: csvToList(required),
      defaultProjectPacks: csvToList(defaults),
      blockedPackNames: csvToList(blocked),
      enforcementMode: mode,
      requireProfileSelection: requireProfile,
    };
    await post('/web/admin/policy', next);
    props.onOk('Policy saved');
    props.onSaved();
  }

  return (
    <div className="panel stack-lg">
      <Field label="Required packs (every project)" hint="Comma-separated pack names."><TextInput value={required} onChange={setRequired} /></Field>
      <Field label="Default packs (new projects)" hint="Comma-separated."><TextInput value={defaults} onChange={setDefaults} /></Field>
      <Field label="Blocked packs" hint="Comma-separated pack names that projects may not install."><TextInput value={blocked} onChange={setBlocked} /></Field>
      <div className="row-form">
        <Field label="Enforcement">
          <Select value={mode} onChange={setMode} options={[
            { value: 'warn', label: 'Warn — findings surface, actions proceed' },
            { value: 'block', label: 'Block — violations reject' },
            { value: 'auto_reconcile', label: 'Auto-reconcile — install missing packs' },
          ]} />
        </Field>
        <Field label="Require profile selection">
          <Select value={requireProfile ? 'yes' : 'no'} onChange={(v) => setRequireProfile(v === 'yes')} options={[{ value: 'no', label: 'Optional' }, { value: 'yes', label: 'Required' }]} />
        </Field>
      </div>
      <div><AsyncButton variant="primary" action={save} onError={props.onError}>Save policy</AsyncButton></div>
    </div>
  );
}

// ── Exposure ─────────────────────────────────────────────────────────────────

const EXPOSURE_TOGGLES: { key: keyof HostExposurePolicy; label: string; hint: string }[] = [
  { key: 'webUiEnabled', label: 'Web UI', hint: 'Serve this browser app on the data-plane listener.' },
  { key: 'adminUiEnabled', label: 'Admin UI (legacy)', hint: 'Serve the legacy browser admin UI.' },
  { key: 'requireTls', label: 'Require TLS', hint: 'Externally exposed control surfaces must sit behind TLS.' },
  { key: 'identityApiEnabled', label: 'Identity API', hint: 'Serve the identity/audit control-plane API over HTTP.' },
  { key: 'landscapeApiEnabled', label: 'Landscape API', hint: 'Serve the landscape control-plane API over HTTP.' },
  { key: 'projectPolicyApiEnabled', label: 'Project-policy API', hint: 'Serve the project-policy control-plane API over HTTP.' },
  { key: 'operationsApiEnabled', label: 'Operations API', hint: 'Serve health/usage/quota over HTTP.' },
  { key: 'cliControlEnabled', label: 'CLI control', hint: 'Allow local CLI/container control workflows.' },
];

function ExposureTab() {
  const toast = useToast();
  const exposure = useAsync<HostExposurePolicy>(() => get('/web/admin/exposure'), []);
  return (
    <AsyncView state={exposure}>
      {(e) => <ExposureForm policy={e} onSaved={exposure.reload} onOk={toast.ok} onError={toast.bad} />}
    </AsyncView>
  );
}

function ExposureForm(props: { policy: HostExposurePolicy; onSaved: () => void; onOk: (m: string) => void; onError: (m: string) => void }) {
  const [p, setP] = useState<HostExposurePolicy>(props.policy);
  const set = (patch: Partial<HostExposurePolicy>) => setP((s) => ({ ...s, ...patch }));

  async function save() {
    await post('/web/admin/exposure', p);
    props.onOk('Exposure policy saved');
    props.onSaved();
  }

  return (
    <div className="panel stack-lg">
      <p className="hint">Which control-plane surfaces this instance serves. Changing these affects what is reachable over HTTP — take care.</p>
      <Field label="Admin API mode">
        <Select value={p.adminApiMode} onChange={(v) => set({ adminApiMode: v })} options={['disabled', 'local_only', 'private_network', 'public'].map((m) => ({ value: m, label: m }))} />
      </Field>
      <div className="toggle-grid">
        {EXPOSURE_TOGGLES.map((t) => (
          <label key={t.key} className="toggle-row">
            <input type="checkbox" checked={!!p[t.key]} onChange={(e) => set({ [t.key]: e.target.checked } as Partial<HostExposurePolicy>)} />
            <span className="cell-stack">
              <strong>{t.label}</strong>
              <span className="hint">{t.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div><AsyncButton variant="primary" action={save} onError={props.onError}>Save exposure policy</AsyncButton></div>
    </div>
  );
}

// ── Backups (container git-backing) ──────────────────────────────────────────

function BackupsTab() {
  const toast = useToast();
  const bindings = useAsync<{ bindings: GitBackingBinding[] }>(() => get('/web/admin/git-backing'), []);
  const [adding, setAdding] = useState(false);
  const [scopeKind, setScopeKind] = useState('unit');
  const [scopeId, setScopeId] = useState('');
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('main');

  async function bind() {
    await post('/web/admin/git-backing', { scopeKind, scopeId: scopeKind === 'instance' ? undefined : scopeId, remote, branch });
    toast.ok('Backup repo bound');
    setAdding(false);
    setRemote('');
    setScopeId('');
    bindings.reload();
  }
  async function sync(id: string) {
    await post('/web/admin/git-backing/sync', { id });
    toast.ok('Sync run');
    bindings.reload();
  }
  async function remove(id: string) {
    await post('/web/admin/git-backing/remove', { id });
    toast.ok('Binding removed');
    bindings.reload();
  }

  return (
    <div className="stack-lg">
      <div className="view-head">
        <p className="hint">Container-level backup repos: mirror a unit's subtree or the whole instance structure to git. Never mirrors secrets or live sessions.</p>
        <Button variant="primary" onClick={() => setAdding(true)}>
          + Bind backup repo
        </Button>
      </div>
      <AsyncView state={bindings}>
        {(d) => (
          <DataTable<GitBackingBinding>
            rowKey={(b) => b.id}
            empty="No backup repos bound."
            rows={d.bindings}
            columns={[
              { key: 'scope', header: 'Scope', cell: (b) => <code>{b.scopeKind}{b.scopeId ? `:${b.scopeId}` : ''}</code> },
              { key: 'remote', header: 'Remote', cell: (b) => <code className="subtle">{b.remote}</code> },
              { key: 'sync', header: 'Last sync', cell: (b) => <span className="hint">{b.lastSyncAt ? new Date(b.lastSyncAt).toLocaleString() : 'never'}</span> },
              {
                key: 'act',
                header: '',
                cell: (b) => (
                  <div className="row-actions">
                    <AsyncButton size="sm" action={() => sync(b.id)} onError={toast.bad}>Sync now</AsyncButton>
                    <ConfirmButton label="Unbind" title="Unbind backup" message="Stop backing up this scope? The remote repo is left untouched." confirmLabel="Unbind" action={() => remove(b.id)} onError={toast.bad} />
                  </div>
                ),
              },
            ]}
          />
        )}
      </AsyncView>
      {adding && (
        <Modal
          title="Bind a backup repository"
          onClose={() => setAdding(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <AsyncButton variant="primary" action={bind} onError={toast.bad} disabled={!remote || (scopeKind !== 'instance' && !scopeId)}>Bind</AsyncButton>
            </>
          }
        >
          <div className="stack-lg">
            <Field label="Scope">
              <Select value={scopeKind} onChange={setScopeKind} options={[{ value: 'unit', label: 'Organization unit subtree' }, { value: 'instance', label: 'Whole instance structure' }]} />
            </Field>
            {scopeKind !== 'instance' && (
              <Field label="Unit id"><TextInput value={scopeId} onChange={setScopeId} placeholder="company_a.it" /></Field>
            )}
            <Field label="Remote URL"><TextInput value={remote} onChange={setRemote} placeholder="https://github.com/org/backup.git" /></Field>
            <Field label="Branch"><TextInput value={branch} onChange={setBranch} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Instance settings shell ──────────────────────────────────────────────────

const TABS = [
  { id: 'packs', label: 'Global packs' },
  { id: 'policy', label: 'Policy' },
  { id: 'exposure', label: 'Exposure' },
  { id: 'backups', label: 'Backups' },
];

export function Instance() {
  const [tab, setTab] = useState('packs');
  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Instance settings</h2>
          <p className="hint">Instance-wide packs, project policy, control-plane exposure, and backup repositories.</p>
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onSelect={setTab} />
      <div className="tab-panel">
        {tab === 'packs' && <GlobalPacksTab />}
        {tab === 'policy' && <PolicyTab />}
        {tab === 'exposure' && <ExposureTab />}
        {tab === 'backups' && <BackupsTab />}
      </div>
    </div>
  );
}
