import { useState } from 'react';
import { asList, get, post, postBinary } from '../api';
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
  MultiSelect,
  Select,
  Tabs,
  TextInput,
  useAsync,
  useToast,
  type MultiSelectOption,
} from '../ui';
import { GitCredentialCard, GitPatSummary } from '../components/GitCredentialCard';
import { InfoTip } from '../components/InfoTip';
import { UnitSelect } from '../components/UnitSelect';
import type {
  AvailableProfile,
  GitBackingBinding,
  HostExposurePolicy,
  InstancePackPolicy,
  OrganizationUnitRecord,
  PackDescriptor,
} from '../types';

// Contents counts prefer the enriched id arrays, falling back to the numeric
// counts when the server sends only those.
const profileCount = (p: PackDescriptor): number => p.profileIds?.length ?? p.profiles ?? 0;
const languageCount = (p: PackDescriptor): number => p.languageIds?.length ?? p.languages ?? 0;
const ruleCount = (p: PackDescriptor): number => p.ruleIds?.length ?? p.rules ?? 0;

// ── Global packs ─────────────────────────────────────────────────────────────

/** A pack's contents cell: the compact `Np · Nl · Nr` summary, expandable to the
 *  concrete profile/language/rule ids when the server enriched them. */
function PackContents({ pack }: { pack: PackDescriptor }) {
  const [open, setOpen] = useState(false);
  const profileIds = pack.profileIds ?? [];
  const languageIds = pack.languageIds ?? [];
  const ruleIds = pack.ruleIds ?? [];
  const summary = `${profileCount(pack)}p · ${languageCount(pack)}l · ${ruleCount(pack)}r`;
  const hasDetail = profileIds.length + languageIds.length + ruleIds.length > 0;
  if (!hasDetail) return <span className="hint">{summary}</span>;
  return (
    <div className="cell-stack">
      <button type="button" className="pack-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden>{open ? '▾' : '▸'}</span> {summary}
      </button>
      {open && (
        <div className="pack-contents">
          {profileIds.length > 0 && (
            <div className="pack-contents-row">
              <span className="pack-contents-k">Profiles</span>
              <div className="chip-row">{profileIds.map((id) => <Badge key={id} tone="accent">{id}</Badge>)}</div>
            </div>
          )}
          {languageIds.length > 0 && (
            <div className="pack-contents-row">
              <span className="pack-contents-k">Languages</span>
              <div className="chip-row">{languageIds.map((id) => <Badge key={id} tone="neutral">{id}</Badge>)}</div>
            </div>
          )}
          {ruleIds.length > 0 && (
            <div className="pack-contents-row">
              <span className="pack-contents-k">Rules</span>
              <div className="chip-row">{ruleIds.map((id) => <Badge key={id} tone="neutral">{id}</Badge>)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GlobalPacksTab() {
  const toast = useToast();
  const packs = useAsync<PackDescriptor[]>(() => get('/web/admin/packs').then((d) => asList<PackDescriptor>(d, 'packs')), []);
  const [adding, setAdding] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [nameOverride, setNameOverride] = useState('');

  async function install() {
    if (!file) return;
    const headers: Record<string, string> = nameOverride.trim() ? { 'X-Wairon-Pack-Name': nameOverride.trim() } : {};
    const d = await postBinary<PackDescriptor>('/web/admin/packs/upload', file, headers);
    toast.ok(`Installed “${d.name}”`);
    setAdding(false);
    setFile(null);
    setNameOverride('');
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
            rows={d}
            columns={[
              { key: 'name', header: 'Pack', cell: (p) => <div className="cell-stack"><strong>{p.name}</strong><code className="subtle">{p.ref}</code></div> },
              { key: 'tier', header: 'Tier', cell: (p) => <Badge tone={p.tier === 'image' ? 'accent' : 'neutral'}>{p.tier ?? 'instance'}</Badge> },
              { key: 'counts', header: 'Contents', cell: (p) => <PackContents pack={p} /> },
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
              <AsyncButton variant="primary" action={install} onError={toast.bad} disabled={!file}>Install</AsyncButton>
            </>
          }
        >
          <div className="stack-lg">
            <p className="hint">Upload a <code>.wpack</code> archive. Only declarative packs (profiles + language/platform tables) install here; code packs stay filesystem-only.</p>
            <Field label="Pack archive (.wpack)">
              <input className="input" type="file" accept=".wpack,.zip,application/zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label="Name override (optional)" hint="Defaults to the pack name in the archive's manifest.">
              <TextInput value={nameOverride} onChange={setNameOverride} />
            </Field>
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

/** Ensure any currently-selected value still appears as a togglable option even
 *  when the live catalog no longer lists it (a stale policy entry), so it renders
 *  and can be removed rather than vanishing. */
function withSelected(options: MultiSelectOption[], selected: string[], noteHint: string): MultiSelectOption[] {
  const known = new Set(options.map((o) => o.value));
  const extra = selected.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v, hint: noteHint }));
  return extra.length ? [...options, ...extra] : options;
}

function PolicyForm(props: { policy: InstancePackPolicy; onSaved: () => void; onError: (m: string) => void; onOk: (m: string) => void }) {
  const packs = useAsync<PackDescriptor[]>(() => get('/web/admin/packs').then((d) => asList<PackDescriptor>(d, 'packs')), []);
  const profiles = useAsync<AvailableProfile[]>(() => get('/web/admin/profiles').then((d) => asList<AvailableProfile>(d, 'profiles')), []);

  const [required, setRequired] = useState<string[]>(props.policy.requiredGlobalPacks ?? []);
  const [defaults, setDefaults] = useState<string[]>(props.policy.defaultProjectPacks ?? []);
  const [blocked, setBlocked] = useState<string[]>(props.policy.blockedPackNames ?? []);
  const [allowedProfiles, setAllowedProfiles] = useState<string[]>(props.policy.allowedProfileIds ?? []);
  const [requiredProfiles, setRequiredProfiles] = useState<string[]>(props.policy.requiredProfileIds ?? []);
  const [mode, setMode] = useState(props.policy.enforcementMode || 'warn');
  const [requireProfile, setRequireProfile] = useState(props.policy.requireProfileSelection);

  // Pack options (label = name; hint = tier + a small contents count).
  const packOptions: MultiSelectOption[] = (packs.data ?? []).map((p) => ({
    value: p.name,
    label: p.name,
    hint: `${p.tier ? p.tier + ' · ' : ''}${profileCount(p)} profiles`,
  }));
  const packsEmpty: string = packs.loading ? 'Loading packs…' : packs.error ? 'Could not load packs.' : 'No packs installed.';

  // Profile options grouped by source, built-in first, then each pack.
  const profileOptions: MultiSelectOption[] = [...(profiles.data ?? [])]
    .sort((a, b) => {
      const ab = a.source === 'builtin' ? 0 : 1;
      const bb = b.source === 'builtin' ? 0 : 1;
      if (ab !== bb) return ab - bb;
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return a.id.localeCompare(b.id);
    })
    .map((p) => ({
      value: p.id,
      label: p.id,
      hint: p.family,
      group: p.source === 'builtin' ? 'Built-in' : p.source,
    }));
  const profilesEmpty: string = profiles.loading ? 'Loading profiles…' : profiles.error ? 'Could not load profiles.' : 'No profiles available.';

  async function save() {
    const next: InstancePackPolicy = {
      ...props.policy,
      requiredGlobalPacks: required,
      defaultProjectPacks: defaults,
      blockedPackNames: blocked,
      allowedProfileIds: allowedProfiles,
      requiredProfileIds: requiredProfiles,
      enforcementMode: mode,
      requireProfileSelection: requireProfile,
    };
    await post('/web/admin/policy', next);
    props.onOk('Policy saved');
    props.onSaved();
  }

  return (
    <div className="panel stack-lg">
      <Field
        label="Every project must carry"
        hint="Packs required on every project. Enforced per the mode below."
      >
        <MultiSelect
          options={withSelected(packOptions, required, 'not installed')}
          selected={required}
          onChange={setRequired}
          placeholder="Choose packs…"
          emptyLabel={packsEmpty}
        />
      </Field>
      <Field label="New projects start with" hint="Packs installed by default when a project is created.">
        <MultiSelect
          options={withSelected(packOptions, defaults, 'not installed')}
          selected={defaults}
          onChange={setDefaults}
          placeholder="Choose packs…"
          emptyLabel={packsEmpty}
        />
      </Field>
      <Field label="Never allowed" hint="Packs projects may not install.">
        <MultiSelect
          options={withSelected(packOptions, blocked, 'not installed')}
          selected={blocked}
          onChange={setBlocked}
          placeholder="Choose packs…"
          emptyLabel={packsEmpty}
        />
      </Field>
      <Field
        label="Profiles — selectable"
        hint="Profiles projects may choose from. Leave empty to allow all."
      >
        <MultiSelect
          options={withSelected(profileOptions, allowedProfiles, 'unknown source')}
          selected={allowedProfiles}
          onChange={setAllowedProfiles}
          placeholder="Choose profiles…"
          emptyLabel={profilesEmpty}
        />
      </Field>
      <Field
        label="Profiles — always applied"
        hint="Profiles enforced on every project regardless of the project's own selection."
      >
        <MultiSelect
          options={withSelected(profileOptions, requiredProfiles, 'unknown source')}
          selected={requiredProfiles}
          onChange={setRequiredProfiles}
          placeholder="Choose profiles…"
          emptyLabel={profilesEmpty}
        />
      </Field>
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
  const units = useAsync<{ units: OrganizationUnitRecord[] }>(
    () => get<{ units: OrganizationUnitRecord[] }>('/web/admin/org/units').catch(() => ({ units: [] as OrganizationUnitRecord[] })),
    [],
  );
  // undefined = modal closed; null = create; a binding = edit.
  const [editing, setEditing] = useState<GitBackingBinding | null | undefined>(undefined);

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
        <Button variant="primary" onClick={() => setEditing(null)}>
          + Bind backup repo
        </Button>
      </div>
      <GitCredentialCard />
      <AsyncView state={bindings}>
        {(d) => (
          <DataTable<GitBackingBinding>
            rowKey={(b) => b.id}
            empty="No backup repos bound."
            rows={d.bindings}
            columns={[
              {
                key: 'scope',
                header: 'Scope',
                cell: (b) => (
                  <span className="cell-inline">
                    <code>{b.scopeKind}{b.scopeId ? `:${b.scopeId}` : ''}</code>
                    {b.includeCredentials && <Badge tone="warn">+cred hashes</Badge>}
                  </span>
                ),
              },
              { key: 'remote', header: 'Remote', cell: (b) => <code className="subtle">{b.remote}</code> },
              {
                key: 'auth',
                header: 'Auth',
                cell: (b) =>
                  b.credentialRef ? <Badge tone="ok">own PAT</Badge> : <Badge tone="neutral">shared token</Badge>,
              },
              { key: 'sync', header: 'Last sync', cell: (b) => <span className="hint">{b.lastSyncAt ? new Date(b.lastSyncAt).toLocaleString() : 'never'}</span> },
              {
                key: 'act',
                header: '',
                cell: (b) => (
                  <div className="row-actions">
                    <AsyncButton size="sm" action={() => sync(b.id)} onError={toast.bad}>Sync now</AsyncButton>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(b)}>Edit</Button>
                    <ConfirmButton label="Unbind" title="Unbind backup" message="Stop backing up this scope? The remote repo is left untouched." confirmLabel="Unbind" action={() => remove(b.id)} onError={toast.bad} />
                  </div>
                ),
              },
            ]}
          />
        )}
      </AsyncView>
      {editing !== undefined && (
        <BackupBindModal
          existing={editing}
          units={units.data?.units ?? []}
          onClose={() => setEditing(undefined)}
          onDone={() => {
            setEditing(undefined);
            bindings.reload();
          }}
        />
      )}
    </div>
  );
}

/** Create OR edit a backup binding (one per scope, so an edit re-binds the same
 *  scope in place). Editing keeps the scope fixed and can toggle credentials,
 *  change the remote/branch, or rotate the PAT (blank keeps the current one). */
function BackupBindModal(props: {
  existing: GitBackingBinding | null;
  units: OrganizationUnitRecord[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const isEdit = !!props.existing;
  const [scopeKind, setScopeKind] = useState(props.existing?.scopeKind ?? 'unit');
  const [scopeId, setScopeId] = useState(props.existing?.scopeId ?? '');
  const [remote, setRemote] = useState(props.existing?.remote ?? '');
  const [branch, setBranch] = useState(props.existing?.branch ?? 'main');
  const [pat, setPat] = useState('');
  const [includeCredentials, setIncludeCredentials] = useState(props.existing?.includeCredentials ?? false);

  async function save() {
    await post('/web/admin/git-backing', {
      scopeKind,
      scopeId: scopeKind === 'instance' ? undefined : scopeId,
      remote,
      branch,
      pat: pat.trim() || undefined,
      includeCredentials: scopeKind === 'instance' ? includeCredentials : undefined,
      // Keep this connection's existing per-connection PAT unless a new one is
      // typed (bindScope re-derives + stores it when `pat` is present).
      credentialRef: props.existing?.credentialRef,
    });
    toast.ok(isEdit ? 'Backup updated' : 'Backup repo bound');
    props.onDone();
  }

  const scopeLabel = `${scopeKind}${scopeId ? `:${scopeId}` : ''}`;

  return (
    <Modal
      title={isEdit ? `Edit backup · ${scopeLabel}` : 'Bind a backup repository'}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <AsyncButton
            variant="primary"
            action={save}
            onError={toast.bad}
            disabled={!remote || (scopeKind !== 'instance' && !scopeId)}
          >
            {isEdit ? 'Save' : 'Bind'}
          </AsyncButton>
        </>
      }
    >
      <div className="stack-lg">
        {isEdit ? (
          // Scope is a binding's identity — fixed on edit.
          <Field label="Scope">
            <code className="preview-id">{scopeLabel}</code>
          </Field>
        ) : (
          <Field label="Scope">
            <Select value={scopeKind} onChange={setScopeKind} options={[{ value: 'unit', label: 'Organization unit subtree' }, { value: 'instance', label: 'Whole instance structure' }]} />
          </Field>
        )}
        {!isEdit && scopeKind !== 'instance' && (
          <Field label="Unit subtree" hint="The unit whose subtree is mirrored. Backs up structure only — never secrets or sessions.">
            <UnitSelect
              units={props.units}
              value={scopeId}
              onChange={setScopeId}
              allowEmpty={false}
              placeholder="Choose a unit…"
            />
          </Field>
        )}
        {scopeKind === 'instance' && (
          <Checkbox
            checked={includeCredentials}
            onChange={setIncludeCredentials}
            label={
              <>
                Include credential hashes
                <InfoTip label="About backing up credential hashes">
                  <p>
                    <strong>Off (default):</strong> the backup carries the org structure, project registry, and all
                    project specs — but <strong>not</strong> <code>auth/credentials.json</code>. Safer: no password or
                    agent-token hashes leave the box.
                  </p>
                  <p>
                    <strong>On:</strong> also mirrors the <em>hashed</em> credential records, so a full restore keeps
                    local logins and agent tokens. The hashes then live in the remote repo (still never plaintext, and
                    the secret store is never mirrored either way).
                  </p>
                  <p>SSO users re-authenticate via your IdP regardless, so most instances can leave this off.</p>
                </InfoTip>
              </>
            }
            hint="Turn on only if you need to restore local passwords / agent tokens from this backup. Turning it off removes the hashes from the repo on the next sync."
          />
        )}
        <Field label="Remote URL"><TextInput value={remote} onChange={setRemote} placeholder="https://github.com/org/backup.git" /></Field>
        <Field label="Branch"><TextInput value={branch} onChange={setBranch} /></Field>
        <Field
          label={isEdit ? 'Access token' : 'Access token for this connection (optional)'}
          info={<GitPatSummary />}
          hint={
            isEdit
              ? props.existing?.credentialRef
                ? 'A per-connection PAT is set. Leave blank to keep it, or type a new one to rotate.'
                : 'Uses the shared fallback token. Type a PAT here to give this connection its own.'
              : "A PAT for this repo's org/account. Leave blank to use the shared fallback token above. Stored write-only; never mirrored."
          }
        >
          <TextInput type="password" value={pat} onChange={setPat} placeholder="github_pat_… / ghp_… / glpat-…" />
        </Field>
      </div>
    </Modal>
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
