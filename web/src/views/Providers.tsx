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
  TextInput,
  useAsync,
  useToast,
} from '../ui';
import type { IdentityProviderConfig } from '../types';

const PROVIDER_TYPES = ['oidc', 'keycloak', 'authentik', 'google', 'entra'];

const csvToList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const listToCsv = (l?: string[]): string => (l ?? []).join(', ');

function ProviderModal(props: { existing?: IdentityProviderConfig; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const isEdit = !!props.existing;
  const [f, setF] = useState<IdentityProviderConfig>(
    props.existing ?? {
      id: '',
      providerType: 'oidc',
      displayName: '',
      issuerUrl: '',
      clientId: '',
      clientSecretRef: '',
      enabled: true,
    },
  );
  const [domains, setDomains] = useState(listToCsv(props.existing?.allowedDomains));
  const [adminGroups, setAdminGroups] = useState(listToCsv(props.existing?.adminGroupClaims));
  const [redirects, setRedirects] = useState(listToCsv(props.existing?.allowedRedirectUris));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const set = (patch: Partial<IdentityProviderConfig>) => setF((s) => ({ ...s, ...patch }));

  async function save() {
    const record: IdentityProviderConfig = {
      ...f,
      allowedDomains: csvToList(domains),
      adminGroupClaims: csvToList(adminGroups),
      allowedRedirectUris: csvToList(redirects),
    };
    await post('/web/admin/providers', record);
    toast.ok(isEdit ? 'Provider updated' : `Provider “${f.id}” added`);
    props.onSaved();
    props.onClose();
  }

  return (
    <Modal
      wide
      title={isEdit ? `Edit provider · ${props.existing!.id}` : 'Add identity provider'}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <AsyncButton variant="primary" action={save} onError={toast.bad} disabled={!f.id || !f.clientId}>
            {isEdit ? 'Save' : 'Add'}
          </AsyncButton>
        </>
      }
    >
      <div className="stack-lg">
        <div className="row-form">
          <Field label="Provider id">
            <TextInput value={f.id} onChange={(v) => set({ id: v })} disabled={isEdit} placeholder="corp-sso" />
          </Field>
          <Field label="Type">
            <Select
              value={f.providerType}
              onChange={(v) => set({ providerType: v })}
              options={PROVIDER_TYPES.map((t) => ({ value: t, label: t }))}
            />
          </Field>
          <Field label="Sign-in label">
            <TextInput value={f.displayName ?? ''} onChange={(v) => set({ displayName: v })} placeholder="Company SSO" />
          </Field>
        </div>
        <Field label="Issuer URL" hint="OIDC discovery base — endpoints resolve from /.well-known unless overridden below.">
          <TextInput value={f.issuerUrl ?? ''} onChange={(v) => set({ issuerUrl: v })} placeholder="https://sso.example.com/realms/main" />
        </Field>
        <div className="row-form">
          <Field label="Client id">
            <TextInput value={f.clientId ?? ''} onChange={(v) => set({ clientId: v })} />
          </Field>
          <Field label="Client secret ref" hint="Name of a secret set on the Secrets card below.">
            <TextInput value={f.clientSecretRef ?? ''} onChange={(v) => set({ clientSecretRef: v })} placeholder="corp-sso-secret" />
          </Field>
        </div>
        <Field label="Allowed email domains" hint="Comma-separated. First-login provisioning is limited to these.">
          <TextInput value={domains} onChange={setDomains} placeholder="example.com, corp.example.com" />
        </Field>
        <Field label="Admin group claims" hint="Comma-separated. Members of these groups become instance admins.">
          <TextInput value={adminGroups} onChange={setAdminGroups} placeholder="wairon-admins" />
        </Field>
        <Field label="Allowed redirect URIs" hint="Comma-separated exact-match allowlist. Empty = accept any.">
          <TextInput value={redirects} onChange={setRedirects} />
        </Field>

        <button className="btn btn-ghost btn-sm" onClick={() => setShowAdvanced((s) => !s)}>
          {showAdvanced ? '▾' : '▸'} Split-horizon endpoint overrides
        </button>
        {showAdvanced && (
          <div className="panel stack-lg">
            <p className="hint">
              Front-channel (browser) vs back-channel (server) endpoints — set these when the token/JWKS endpoints live on a
              VPC-internal address the browser can't reach.
            </p>
            <Field label="Authorization endpoint (front-channel)">
              <TextInput value={f.authorizationEndpoint ?? ''} onChange={(v) => set({ authorizationEndpoint: v })} />
            </Field>
            <Field label="Token endpoint (back-channel)">
              <TextInput value={f.tokenEndpoint ?? ''} onChange={(v) => set({ tokenEndpoint: v })} />
            </Field>
            <Field label="JWKS URI (back-channel)">
              <TextInput value={f.jwksUri ?? ''} onChange={(v) => set({ jwksUri: v })} />
            </Field>
            <Field label="Userinfo endpoint (back-channel)">
              <TextInput value={f.userinfoEndpoint ?? ''} onChange={(v) => set({ userinfoEndpoint: v })} />
            </Field>
          </div>
        )}
        <Field label="Enabled">
          <Select
            value={f.enabled ? 'yes' : 'no'}
            onChange={(v) => set({ enabled: v === 'yes' })}
            options={[
              { value: 'yes', label: 'Enabled (shown on the login screen)' },
              { value: 'no', label: 'Disabled' },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
}

function SecretsCard() {
  const toast = useToast();
  const refs = useAsync<{ refs: string[] }>(() => get('/web/admin/secrets'), []);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  async function save() {
    await post('/web/admin/secrets', { key, value });
    toast.ok(`Secret “${key}” saved`);
    setValue('');
    refs.reload();
  }

  return (
    <div className="panel">
      <h4>Secrets</h4>
      <p className="hint">Client secrets and tokens are write-only — set them here and reference them by name (never shown again).</p>
      <AsyncView state={refs}>
        {(d) => (
          <div className="chip-row" style={{ marginBottom: 12 }}>
            {d.refs.length === 0 ? <span className="hint">No secrets set.</span> : d.refs.map((r) => <Badge key={r} tone="neutral">{r}</Badge>)}
          </div>
        )}
      </AsyncView>
      <div className="row-form">
        <Field label="Secret name">
          <TextInput value={key} onChange={setKey} placeholder="corp-sso-secret" />
        </Field>
        <Field label="Value">
          <TextInput type="password" value={value} onChange={setValue} />
        </Field>
        <div className="row-form-action">
          <AsyncButton variant="primary" action={save} onError={toast.bad} disabled={!key || !value}>
            Save secret
          </AsyncButton>
        </div>
      </div>
    </div>
  );
}

export function Providers() {
  const toast = useToast();
  const providers = useAsync<{ providers: IdentityProviderConfig[] }>(() => get('/web/admin/providers'), [], ['providers']);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<IdentityProviderConfig | null>(null);

  async function remove(id: string) {
    await post('/web/admin/providers/remove', { id });
    toast.ok('Provider removed');
    providers.reload();
  }

  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Sign-in (SSO)</h2>
          <p className="hint">Identity providers users can sign in with. OIDC, Keycloak, Authentik, Google, Entra.</p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          + Add provider
        </Button>
      </div>

      <AsyncView state={providers}>
        {(d) => (
          <DataTable<IdentityProviderConfig>
            rowKey={(p) => p.id}
            empty="No identity providers configured. Add one so users can sign in with SSO."
            rows={d.providers}
            columns={[
              {
                key: 'id',
                header: 'Provider',
                cell: (p) => (
                  <div className="cell-stack">
                    <strong>{p.displayName || p.id}</strong>
                    <code className="subtle">{p.providerType} · {p.id}</code>
                  </div>
                ),
              },
              { key: 'issuer', header: 'Issuer', cell: (p) => <code className="subtle">{p.issuerUrl || '—'}</code> },
              { key: 'enabled', header: 'Status', cell: (p) => <Badge tone={p.enabled ? 'ok' : 'neutral'}>{p.enabled ? 'enabled' : 'disabled'}</Badge> },
              {
                key: 'act',
                header: '',
                width: '1%',
                cell: (p) => (
                  <div className="row-actions">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                    <ConfirmButton
                      label="Remove"
                      title="Remove provider"
                      message={`Remove “${p.displayName || p.id}”? Users can no longer sign in with it.`}
                      confirmLabel="Remove"
                      action={() => remove(p.id)}
                      onError={toast.bad}
                    />
                  </div>
                ),
              },
            ]}
          />
        )}
      </AsyncView>

      <div style={{ marginTop: 20 }}>
        <SecretsCard />
      </div>

      {adding && <ProviderModal onClose={() => setAdding(false)} onSaved={providers.reload} />}
      {editing && <ProviderModal existing={editing} onClose={() => setEditing(null)} onSaved={providers.reload} />}
    </div>
  );
}
