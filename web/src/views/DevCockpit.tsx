import { useEffect, useMemo, useState } from 'react';
import { asList, get, mcpCall, post } from '../api';
import { AsyncButton, AsyncView, Badge, Button, ErrorNote, Field, Modal, Select, Spinner, useAsync, useToast } from '../ui';
import type { DevCommandResult, DevReviewDecision, ReviewNote, ReviewRequest, ReviewStatus } from '../types';

/**
 * The `wairon dev` cockpit, browser side. Mounted only by the local dev shell (the session context says
 * `local`), because the server mounts /web/dev/reviews, /web/dev/reviews/decide and /web/dev/commands only
 * under dev mode.
 *
 *  - ReviewHost: reads the pending review requests on load and on every `reviews` realtime nudge, pops up a
 *    non-blocking notice for a pending request and opens the review screen from it.
 *  - ReviewScreen: the agent's note, the specs changed since the last approval, the current validation
 *    findings, a comment box, a note box per changed spec, and Lock / Approve / Request changes.
 *  - CommandsPanel: the CLI's own lock (whole design or one subsystem), generate and doctor --fix.
 */

const DEV_PROJECT_ID = 'local';

/** One spec changed since the last approval, as `sdd_get_status` names it. */
interface ChangedSpec {
  /** The id a note is pinned to: the spec file's base name. */
  specId: string;
  /** What the status printed for it (a project-relative path). */
  path: string;
}

/**
 * Pull the changed specs out of sdd_get_status' prose. Its approval section lists them as two-space
 * indented lines under a "... since approval" / "differ in bytes" headline. The list can be cut ("... and N
 * more"), so the screen also shows the section itself and lets a note be pinned to any spec id.
 */
function parseChangedSpecs(status: string): { specs: ChangedSpec[]; section: string } {
  const lines = status.split(/\r?\n/);
  const start = lines.findIndex((l) => /\d+ specs? .*(since approval|differ)/.test(l));
  if (start < 0) return { specs: [], section: '' };
  const section: string[] = [lines[start].trim()];
  const specs: ChangedSpec[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s{2}\S/.test(l)) break;
    section.push(l);
    const m = /^\s{2}(?:[~+-]\s+)?(\S.*?)\s*$/.exec(l);
    if (m && !m[1].startsWith('…')) {
      const path = m[1];
      const base = path.split(/[\\/]/).pop() ?? path;
      specs.push({ specId: base.replace(/\.(ya?ml|json)$/i, ''), path });
    }
  }
  return { specs, section: section.join('\n') };
}

interface Findings {
  errors: any[];
  warnings: any[];
}

// ── Listing + popup ──────────────────────────────────────────────────────────

export function ReviewHost() {
  const reviews = useAsync<ReviewRequest[]>(
    async () => asList<ReviewRequest>(await get('/web/dev/reviews'), 'reviews'),
    [],
    ['reviews'],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const pending = (reviews.data ?? []).filter((r) => r.status === 'pending');
  const open = openId ? pending.find((r) => r.id === openId) : undefined;
  const popup = pending.find((r) => r.id !== openId && !dismissed.has(r.id));

  // A request decided elsewhere (the terminal's lock) leaves the pending list: close its screen.
  useEffect(() => {
    if (openId && reviews.data && !open) setOpenId(null);
  }, [openId, reviews.data, open]);

  return (
    <>
      {popup && !open && (
        <div className="review-popup" role="status">
          <div className="review-popup-head">
            <strong>{popup.kind === 'lock' ? 'Lock requested' : 'Review requested'}</strong>
            {pending.length > 1 && <Badge tone="neutral">{pending.length} pending</Badge>}
          </div>
          <p className="review-popup-note">{popup.note}</p>
          <div className="row-actions">
            <Button size="sm" variant="ghost" onClick={() => setDismissed((s) => new Set(s).add(popup.id))}>
              Later
            </Button>
            <Button size="sm" variant="primary" onClick={() => setOpenId(popup.id)}>
              Review
            </Button>
          </div>
        </div>
      )}
      {open && <ReviewScreen request={open} onClose={() => setOpenId(null)} onDecided={() => reviews.reload()} />}
    </>
  );
}

// ── Review screen ────────────────────────────────────────────────────────────

function ReviewScreen(props: { request: ReviewRequest; onClose: () => void; onDecided: () => void }) {
  const { request } = props;
  const toast = useToast();
  const isLock = request.kind === 'lock';
  const status = useAsync<string>(
    async () => {
      const r = await mcpCall<unknown>(DEV_PROJECT_ID, 'sdd_get_status', {});
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
    [request.id],
    [`project:${DEV_PROJECT_ID}`],
  );
  const findings = useAsync<Findings>(
    async () => {
      const r = await mcpCall<Findings>(DEV_PROJECT_ID, 'sdd_validate_tree', {});
      return { errors: r.errors ?? [], warnings: r.warnings ?? [] };
    },
    [request.id],
    [`project:${DEV_PROJECT_ID}`],
  );
  const changed = useMemo(() => parseChangedSpecs(status.data ?? ''), [status.data]);

  const [comment, setComment] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [extraId, setExtraId] = useState('');
  const [lockOutput, setLockOutput] = useState<DevCommandResult | null>(null);

  const noteIds = [...new Set([...changed.specs.map((s) => s.specId), ...Object.keys(notes)])];

  async function decide(outcome: ReviewStatus) {
    const pinned: ReviewNote[] = Object.entries(notes)
      .map(([specId, note]) => ({ specId, note: note.trim() }))
      .filter((n) => n.note.length > 0);
    const body: { id: string; outcome: ReviewStatus; comment?: string; notes?: ReviewNote[] } = { id: request.id, outcome };
    if (comment.trim()) body.comment = comment.trim();
    if (pinned.length > 0) body.notes = pinned;
    const res = await post<DevReviewDecision>('/web/dev/reviews/decide', body);
    if (res.lock && !res.lock.ok) {
      // The lock failed: the request stays pending and the human sees what the lock printed.
      setLockOutput(res.lock);
      props.onDecided();
      return;
    }
    toast.ok(outcome === 'locked' ? 'Locked' : outcome === 'approved' ? 'Approved' : 'Changes requested');
    props.onDecided();
    props.onClose();
  }

  return (
    <Modal
      wide
      title={isLock ? 'Lock request' : 'Review request'}
      onClose={props.onClose}
      footer={
        <>
          <AsyncButton variant="danger" action={() => decide('changes_requested')} onError={toast.bad}>
            Request changes
          </AsyncButton>
          {isLock ? (
            <AsyncButton variant="primary" action={() => decide('locked')} onError={toast.bad}>
              {request.subsystem ? `Lock ${request.subsystem}` : 'Lock'}
            </AsyncButton>
          ) : (
            <AsyncButton variant="primary" action={() => decide('approved')} onError={toast.bad}>
              Approve
            </AsyncButton>
          )}
        </>
      }
    >
      <div className="stack-lg">
        <section className="stack-sm">
          <h4>The agent's note</h4>
          <p className="review-note">{request.note}</p>
          <p className="hint">
            Requested {new Date(request.requestedAt).toLocaleString()}
            {request.subsystem ? ` · subsystem ${request.subsystem}` : ''}
          </p>
        </section>

        {lockOutput && (
          <section className="stack-sm">
            <ErrorNote>The lock failed; the request is still pending.</ErrorNote>
            <pre className="cmd-output">{lockOutput.output.join('\n')}</pre>
          </section>
        )}

        <section className="stack-sm">
          <h4>Changed since the last approval</h4>
          <AsyncView state={status}>
            {() =>
              changed.specs.length === 0 && !changed.section ? (
                <p className="hint">No spec has changed since the last approval.</p>
              ) : (
                <>
                  <pre className="cmd-output">{changed.section}</pre>
                  {noteIds.map((id) => (
                    <Field key={id} label={`Note on ${id}`}>
                      <textarea
                        className="input"
                        rows={2}
                        value={notes[id] ?? ''}
                        onChange={(e) => setNotes((n) => ({ ...n, [id]: e.target.value }))}
                      />
                    </Field>
                  ))}
                </>
              )
            }
          </AsyncView>
          <div className="list-line">
            <input
              className="input"
              placeholder="Pin a note to another spec id"
              value={extraId}
              onChange={(e) => setExtraId(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!extraId.trim()}
              onClick={() => {
                const id = extraId.trim();
                setNotes((n) => (id in n ? n : { ...n, [id]: '' }));
                setExtraId('');
              }}
            >
              Add note
            </Button>
          </div>
        </section>

        <section className="stack-sm">
          <h4>Current findings</h4>
          <AsyncView state={findings}>
            {(f) => (
              <>
                <p>
                  <Badge tone={f.errors.length ? 'bad' : 'ok'}>{f.errors.length} errors</Badge>{' '}
                  <Badge tone={f.warnings.length ? 'warn' : 'ok'}>{f.warnings.length} warnings</Badge>
                </p>
                {[...f.errors, ...f.warnings].slice(0, 30).map((i, n) => (
                  <div key={n} className="review-finding">
                    {i.code ? <code className="subtle">{i.code}</code> : null} {i.specId ? <code>{i.specId}</code> : null}{' '}
                    {i.message}
                  </div>
                ))}
              </>
            )}
          </AsyncView>
        </section>

        <Field label="Comment">
          <textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ── Commands panel ───────────────────────────────────────────────────────────

const COMMANDS: { id: 'lock' | 'generate' | 'doctor'; label: string; explain: string }[] = [
  {
    id: 'lock',
    label: 'Lock',
    explain:
      'Approves the design as it is now (wairon lock) and records your git identity as the approver. Pick a subsystem to re-approve just that one.',
  },
  { id: 'generate', label: 'Generate', explain: 'Refreshes the generated guides, skills and context files from the specs (wairon generate).' },
  {
    id: 'doctor',
    label: 'Doctor --fix',
    explain: 'Finishes unfinished transactions and repairs signatures, type spellings and stale guides (wairon doctor --fix).',
  },
];

export function CommandsPanel() {
  const toast = useToast();
  const graph = useAsync<{ nodes: { id: string; kind: string }[] }>(
    () => get(`/web/graph?tier=project&projectId=${DEV_PROJECT_ID}&level=1`),
    [],
    [`project:${DEV_PROJECT_ID}`],
  );
  const [subsystem, setSubsystem] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<DevCommandResult | null>(null);

  const subsystems = (graph.data?.nodes ?? []).filter((n) => n.kind === 'subsystem').map((n) => n.id);

  async function run(command: 'lock' | 'generate' | 'doctor') {
    setRunning(command);
    setResult(null);
    try {
      const body: { command: string; subsystem?: string } = { command };
      if (command === 'lock' && subsystem) body.subsystem = subsystem;
      const res = await post<DevCommandResult>('/web/dev/commands', body);
      setResult(res);
      if (res.ok) toast.ok(`${command} finished`);
      else toast.bad(`${command} failed`);
    } catch (e) {
      toast.bad(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="view-pad stack-lg">
      <div className="view-head">
        <div>
          <h2>Commands</h2>
          <p className="hint">The CLI's own commands, run here. One at a time.</p>
        </div>
      </div>
      {COMMANDS.map((c) => (
        <section key={c.id} className="stack-sm">
          <div className="list-line">
            <Button variant={c.id === 'lock' ? 'primary' : 'default'} disabled={running !== null} onClick={() => run(c.id)}>
              {running === c.id ? <Spinner inline /> : c.label}
            </Button>
            {c.id === 'lock' && (
              <Select
                value={subsystem}
                disabled={running !== null}
                onChange={setSubsystem}
                options={[{ value: '', label: 'Whole design' }, ...subsystems.map((s) => ({ value: s, label: s }))]}
              />
            )}
          </div>
          <p className="hint">{c.explain}</p>
        </section>
      ))}
      {result && (
        <section className="stack-sm">
          <h4>
            {result.command} <Badge tone={result.ok ? 'ok' : 'bad'}>{result.ok ? 'ok' : 'failed'}</Badge>
          </h4>
          <pre className="cmd-output">{result.output.join('\n') || '(no output)'}</pre>
        </section>
      )}
    </div>
  );
}
