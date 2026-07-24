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
import type { ApiKeyRecord, ProjectRecord } from '../types';

/** Self-service MCP token management: any signed-in user mints a single-project
 *  token to hand an AI agent, scoped to exactly their own access to that project.
 *  The plaintext token is shown once, on mint. */
export function Tokens() {
  const toast = useToast();
  const tokens = useAsync<{ tokens: ApiKeyRecord[] }>(() => get('/web/tokens'), [], ['tokens']);
  const projects = useAsync<{ projects: ProjectRecord[] }>(() => get('/web/projects'), []);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);

  async function revoke(id: string) {
    await post('/web/tokens/revoke', { id });
    toast.ok('Token revoked');
    tokens.reload();
  }

  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Connect an agent</h2>
          <p className="hint">
            Mint a single-project MCP token for an AI coding agent. A token can never exceed your own access to that
            project, and dies if your account is deactivated.
          </p>
        </div>
        <Button variant="primary" onClick={() => setMinting(true)}>
          + New token
        </Button>
      </div>

      <AsyncView state={tokens}>
        {(d) => (
          <DataTable<ApiKeyRecord>
            rowKey={(t) => t.id}
            empty="No tokens yet. Mint one to connect an agent to a project."
            rows={d.tokens}
            columns={[
              { key: 'label', header: 'Token', cell: (t) => <strong>{t.label || t.id}</strong> },
              {
                key: 'projects',
                header: 'Projects',
                cell: (t) => (
                  <div className="chip-row">
                    {t.projects.map((p) => (
                      <Badge key={p} tone="accent">
                        {p === '*' ? 'all your projects' : p}
                      </Badge>
                    ))}
                  </div>
                ),
              },
              { key: 'created', header: 'Created', cell: (t) => <span className="hint">{new Date(t.createdAt).toLocaleDateString()}</span> },
              {
                key: 'status',
                header: '',
                width: '1%',
                cell: (t) =>
                  t.revokedAt ? (
                    <Badge tone="neutral">revoked</Badge>
                  ) : (
                    <ConfirmButton
                      label="Revoke"
                      title="Revoke token"
                      message="Revoke this token? Any agent using it loses access immediately."
                      confirmLabel="Revoke"
                      action={() => revoke(t.id)}
                      onError={toast.bad}
                    />
                  ),
              },
            ]}
          />
        )}
      </AsyncView>

      {minting && (
        <MintModal
          projects={projects.data?.projects ?? []}
          onClose={() => setMinting(false)}
          onMinted={(token) => {
            setMinted(token);
            setMinting(false);
            tokens.reload();
          }}
        />
      )}
      {minted && <MintedModal token={minted} onClose={() => setMinted(null)} />}
    </div>
  );
}

function MintModal(props: { projects: ProjectRecord[]; onClose: () => void; onMinted: (token: string) => void }) {
  const toast = useToast();
  const [projectId, setProjectId] = useState(props.projects[0]?.id ?? '');
  const [write, setWrite] = useState(false);
  // Optional chained-subproject qualifier (a subsystem id, or a nested chain
  // like 'billing::payments'). Free text on purpose: no endpoint currently
  // marks which subsystems are chained, so instead of offering a dropdown that
  // would list non-chained subsystems too, the server's mint-time validation
  // is the single source of truth — an unknown or non-chained subsystem is
  // rejected there with a clear error.
  const [subproject, setSubproject] = useState('');

  async function mint() {
    const qualifier = subproject.trim();
    const target = qualifier ? `${projectId}::${qualifier}` : projectId;
    const res = await post<{ token: string }>('/web/tokens', { projectId: target, write });
    props.onMinted(res.token);
  }

  return (
    <Modal
      title="Mint an agent token"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <AsyncButton variant="primary" action={mint} onError={toast.bad} disabled={!projectId}>
            Mint
          </AsyncButton>
        </>
      }
    >
      <div className="stack-lg">
        <Field label="Project">
          {props.projects.length === 0 ? (
            <span className="hint">You have no projects to scope a token to yet.</span>
          ) : (
            <Select value={projectId} onChange={setProjectId} options={props.projects.map((p) => ({ value: p.id, label: p.id }))} />
          )}
        </Field>
        <Field
          label="Subproject (optional)"
          hint="Scope the token into a chained subproject: the subsystem id mounting it (e.g. billing, or nested billing::payments). Leave empty for the whole project. Validated on mint — an unknown or non-chained subsystem is rejected."
        >
          <TextInput
            value={subproject}
            onChange={setSubproject}
            placeholder="subsystem id, e.g. billing or billing::payments"
            disabled={!projectId}
          />
        </Field>
        <Field label="Access">
          <Select
            value={write ? 'write' : 'read'}
            onChange={(v) => setWrite(v === 'write')}
            options={[
              { value: 'read', label: 'Read only' },
              { value: 'write', label: 'Read + write' },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
}

function MintedModal(props: { token: string; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal title="Your new token" onClose={props.onClose} footer={<Button onClick={props.onClose}>Done</Button>}>
      <div className="stack-lg">
        <p className="hint">Copy it now — it is shown only once and cannot be retrieved again.</p>
        <code className="token-box">{props.token}</code>
        <Button
          onClick={() => {
            navigator.clipboard?.writeText(props.token).then(
              () => toast.ok('Copied to clipboard'),
              () => toast.bad('Copy failed — select and copy manually'),
            );
          }}
        >
          Copy
        </Button>
      </div>
    </Modal>
  );
}
