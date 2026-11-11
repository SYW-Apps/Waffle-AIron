import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { asList, get, mcpCall, post } from '../api';
import { AsyncButton, AsyncView, Badge, Button, ErrorNote, Field, Modal, Select, Spinner, useAsync, useToast } from '../ui';
import { ThemeSections } from '../ThemeControls';
import type { DevCommandResult, DevReviewDecision, DevStatus, ReviewNote, ReviewRequest, ReviewStatus } from '../types';
import {
  barState,
  branchChipText,
  inPlaceScope,
  lockBody,
  movedScope,
  offersLockInPlace,
  otherBranchLine,
  branchChangeNotice,
  parseMoved,
  type DevApprovalData,
  type MovedScope,
  type ScopeNode,
} from './devCockpitLogic';

/**
 * The `wairon dev` cockpit, browser side. Mounted only by the local dev shell (the session context says
 * `local`), because the server mounts the /web/dev/* routes only under dev mode. The whole page is the cockpit:
 *
 *  - CockpitProvider: reads the approval state (GET /web/dev/approval) and the pending review requests on
 *    load and on every `project:<id>` / `reviews` realtime nudge (no polling), and shows the floating action
 *    bar on every view while there is something to approve: Lock, or Review for a pending request.
 *  - LockModal: every lock is confirmed here - what moved since the last lock, the current warnings, whole
 *    design or one subsystem - then runs and shows the output. Nothing locks without the confirm.
 *  - ReviewScreen: the agent's note, the specs changed since the last lock, the warnings, notes, and
 *    Lock / Approve / Request changes.
 *  - LockInPlaceButton: the Lock action the specs and diagrams views carry.
 *  - SettingsCog: the header cog; appearance, plus Generate and Doctor --fix.
 */

const DEV_PROJECT_ID = 'local';

interface Findings {
  errors: any[];
  warnings: any[];
}

interface Cockpit {
  approval?: DevApprovalData;
  nodes: ScopeNode[];
  scope: MovedScope;
  /** Open the lock confirmation; `subsystem` preselects the scope. */
  openLock: (subsystem?: string) => void;
}

const CockpitContext = createContext<Cockpit | null>(null);

function useCockpit(): Cockpit {
  const c = useContext(CockpitContext);
  if (!c) throw new Error('useCockpit outside CockpitProvider');
  return c;
}

// ── Provider, bar ────────────────────────────────────────────────────────────

export function CockpitProvider(props: { children: ReactNode }) {
  const approvalState = useAsync<DevApprovalData | null>(
    () => get<DevApprovalData>('/web/dev/approval').catch(() => null),
    [],
    [`project:${DEV_PROJECT_ID}`, 'reviews'],
  );
  const reviews = useAsync<ReviewRequest[]>(
    async () => asList<ReviewRequest>(await get('/web/dev/reviews'), 'reviews'),
    [],
    ['reviews'],
  );
  const approval = approvalState.data ?? undefined;
  const toast = useToast();
  // A banner when the checkout's branch changes between two reads of the approval state.
  const lastBranch = useRef<{ seen: boolean; branch?: string }>({ seen: false });
  useEffect(() => {
    if (approvalState.data === undefined || approvalState.data === null) return;
    const branch = approvalState.data.branch;
    const notice = branchChangeNotice(lastBranch.current, branch);
    if (notice) toast.ok(notice);
    lastBranch.current = { seen: true, branch };
  }, [approvalState.data]);
  const pending = (reviews.data ?? []).filter((r) => r.status === 'pending');

  // The spec tree is only needed to place moved specs in a subsystem, i.e. while something moved.
  const need = !!approval && (!approval.approved || approval.verdict.drifted);
  const graph = useAsync<{ nodes: ScopeNode[] }>(
    async () => (need ? get<{ nodes: ScopeNode[] }>(`/web/graph?tier=project&projectId=${DEV_PROJECT_ID}&level=4`) : { nodes: [] }),
    [need],
    need ? [`project:${DEV_PROJECT_ID}`] : [],
  );
  const nodes = useMemo(() => graph.data?.nodes ?? [], [graph.data]);
  const scope = useMemo(() => movedScope(approval?.verdict.moved, nodes), [approval, nodes]);

  const [lock, setLock] = useState<{ subsystem?: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? pending.find((r) => r.id === openId) : undefined;
  // A request decided elsewhere (the terminal's lock) leaves the pending list: close its screen.
  useEffect(() => {
    if (openId && reviews.data && !open) setOpenId(null);
  }, [openId, reviews.data, open]);

  const ctx: Cockpit = { approval, nodes, scope, openLock: (subsystem) => setLock({ subsystem }) };
  const bar = barState(approval, pending.length, pending[0]?.kind);

  return (
    <CockpitContext.Provider value={ctx}>
      {props.children}
      {bar.show && !open && !lock && (
        <div className="syw-card cockpit-bar" role="status">
          <div className="cockpit-bar-text">
            <strong>{bar.line}</strong>
            {approval?.branch && <span className="dim"> on {approval.branch}</span>}
            {bar.action === 'review' && pending[0] && otherBranchLine(pending[0].branch, approval?.branch) && (
              <span className="dim"> ({otherBranchLine(pending[0].branch, approval?.branch)})</span>
            )}
            {bar.action === 'review' && pending[0] && <span className="dim"> {pending[0].note}</span>}
            {bar.action !== 'review' && approval?.verdict.text && approval.verdict.drifted && (
              <span className="dim"> {firstLine(approval.verdict.text)}</span>
            )}
          </div>
          {bar.action === 'review' && pending[0] ? (
            <Button size="sm" variant="primary" onClick={() => setOpenId(pending[0].id)}>
              Review
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => ctx.openLock(scope.subsystem)}>
              Lock
            </Button>
          )}
        </div>
      )}
      {open && (
        <ReviewScreen
          request={open}
          onClose={() => setOpenId(null)}
          onDecided={() => {
            reviews.reload();
            approvalState.reload();
          }}
        />
      )}
      {lock && (
        <LockModal
          initialSubsystem={lock.subsystem}
          run={async (subsystem) => {
            const res = await post<DevCommandResult>('/web/dev/commands', lockBody(subsystem));
            approvalState.reload();
            reviews.reload();
            return res;
          }}
          onClose={() => setLock(null)}
        />
      )}
    </CockpitContext.Provider>
  );
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}

// ── Lock in place ────────────────────────────────────────────────────────────

/**
 * The Lock action of the specs and diagrams views. Shows only while the design is unlocked or moved; scoped
 * to `viewSubsystem` when that is the only subsystem that moved, otherwise a whole-design lock. The
 * confirmation still lets the human change the scope.
 */
export function LockInPlaceButton(props: { viewSubsystem?: string }) {
  const { approval, scope, openLock } = useCockpit();
  if (!offersLockInPlace(approval)) return null;
  const sub = inPlaceScope(props.viewSubsystem, scope);
  return (
    <Button size="sm" variant="primary" title={sub ? `Approve ${sub}` : 'Approve the whole design'} onClick={() => openLock(sub)}>
      {sub ? `Lock ${sub}` : 'Lock'}
    </Button>
  );
}

/** The dev approval state, for views that show it as a line (the floating bar carries the Lock). */
export function useApproval(): DevApprovalData | undefined {
  return useCockpit().approval;
}

/** The header's branch chip: the checkout's branch (or a detached HEAD's short commit). Absent outside a git checkout. */
export function BranchChip() {
  const approval = useCockpit().approval;
  const text = branchChipText(approval);
  if (!text) return null;
  const detached = !approval?.branch;
  return (
    <span className="syw-chip badge badge-neutral branch-chip" data-tip={detached ? 'Detached HEAD' : 'Current git branch'} tabIndex={0}>
      <span aria-hidden="true">⎇</span>
      <span className="branch-chip-name">{text}</span>
    </span>
  );
}

/** The spec-tree nodes the cockpit holds (loaded while something moved), for placing a view in a subsystem. */
export function useScopeNodes(): ScopeNode[] {
  return useCockpit().nodes;
}

// ── Lock confirmation ────────────────────────────────────────────────────────

export function LockModal(props: {
  initialSubsystem?: string;
  /** Pin the scope (a lock request that names its subsystem). */
  fixedSubsystem?: string;
  run: (subsystem?: string) => Promise<DevCommandResult>;
  onClose: () => void;
  /** Called when the modal is closed after a lock that succeeded. */
  onLocked?: () => void;
}) {
  const { approval, nodes } = useCockpit();
  const [subsystem, setSubsystem] = useState(props.fixedSubsystem ?? props.initialSubsystem ?? '');
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [result, setResult] = useState<DevCommandResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const findings = useAsync<Findings>(async () => {
    const r = await mcpCall<Findings>(DEV_PROJECT_ID, 'sdd_validate_tree', {});
    return { errors: r.errors ?? [], warnings: r.warnings ?? [] };
  }, []);
  const moved = parseMoved(approval?.verdict.moved);
  const subsystems = nodes.filter((n) => n.kind === 'subsystem').map((n) => n.id).sort();
  if (subsystem && !subsystems.includes(subsystem)) subsystems.push(subsystem);

  async function confirm() {
    setPhase('running');
    setFailure(null);
    try {
      setResult(await props.run(subsystem || undefined));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    }
    setPhase('done');
  }
  const close = () => {
    if (phase === 'running') return;
    if (result?.ok) props.onLocked?.();
    props.onClose();
  };

  return (
    <Modal
      wide
      title={subsystem ? `Lock ${subsystem}` : 'Lock the design'}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={phase === 'running'}>
            {phase === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {phase !== 'done' && (
            <Button variant="primary" onClick={confirm} disabled={phase === 'running'}>
              {phase === 'running' ? <Spinner inline /> : 'Confirm lock'}
            </Button>
          )}
        </>
      }
    >
      <div className="stack-lg">
        {phase === 'confirm' && (
          <>
            <p className="hint">
              Locking approves the design as it is now and records your git identity as the approver. Nothing is locked
              until you confirm.
              {approval?.approvedAt
                ? ` Last locked ${approval.approvedBy ? `by ${approval.approvedBy} ` : ''}${new Date(approval.approvedAt).toLocaleString()}.`
                : ''}
            </p>
            <Field label="Scope">
              <Select
                value={subsystem}
                disabled={!!props.fixedSubsystem}
                onChange={setSubsystem}
                options={[{ value: '', label: 'Whole design' }, ...subsystems.map((s) => ({ value: s, label: `Subsystem ${s}` }))]}
              />
            </Field>
            <section className="stack-sm">
              <h4>Changed since the last lock</h4>
              {moved.length === 0 ? (
                <p className="hint">{approval?.approved ? 'No spec has changed since the last lock.' : 'The design has no lock yet.'}</p>
              ) : (
                <pre className="cmd-output">{moved.map((m) => `${m.mark} ${m.path}`).join('\n')}</pre>
              )}
            </section>
            <section className="stack-sm">
              <h4>Current findings</h4>
              <FindingsList state={findings} />
            </section>
          </>
        )}
        {phase === 'running' && (
          <p>
            <Spinner inline /> Running the lock...
          </p>
        )}
        {phase === 'done' && (
          <section className="stack-sm">
            {failure ? (
              <ErrorNote>{failure}</ErrorNote>
            ) : (
              <h4>
                lock <Badge tone={result?.ok ? 'ok' : 'bad'}>{result?.ok ? 'locked' : 'failed'}</Badge>
              </h4>
            )}
            {result && <pre className="cmd-output">{result.output.join('\n') || '(no output)'}</pre>}
          </section>
        )}
      </div>
    </Modal>
  );
}

function FindingsList(props: { state: ReturnType<typeof useAsync<Findings>> }) {
  return (
    <AsyncView state={props.state}>
      {(f) => (
        <>
          <p>
            <Badge tone={f.errors.length ? 'bad' : 'ok'}>{f.errors.length} errors</Badge>{' '}
            <Badge tone={f.warnings.length ? 'warn' : 'ok'}>{f.warnings.length} warnings</Badge>
          </p>
          {[
            ...f.errors.map((i) => ({ i, sev: 'error' as const })),
            ...f.warnings.map((i) => ({ i, sev: 'warn' as const })),
          ]
            .slice(0, 30)
            .map(({ i, sev }, n) => (
              <div key={n} className="review-finding">
                <div className="finding-row">
                  <span className={`syw-chip badge ${sev === 'error' ? 'badge-bad' : 'badge-warn'}`}>{sev}</span>
                  {i.code ? <code className="syw-chip badge badge-neutral finding-code">{i.code}</code> : null}
                </div>
                <div className="finding-msg">{i.message}</div>
                {i.specId ? <span className="finding-meta">{i.specId}</span> : null}
              </div>
            ))}
        </>
      )}
    </AsyncView>
  );
}

// ── Review screen ────────────────────────────────────────────────────────────

function ReviewScreen(props: { request: ReviewRequest; onClose: () => void; onDecided: () => void }) {
  const { request } = props;
  const toast = useToast();
  const { approval } = useCockpit();
  const isLock = request.kind === 'lock';
  const findings = useAsync<Findings>(
    async () => {
      const r = await mcpCall<Findings>(DEV_PROJECT_ID, 'sdd_validate_tree', {});
      return { errors: r.errors ?? [], warnings: r.warnings ?? [] };
    },
    [request.id],
    [`project:${DEV_PROJECT_ID}`],
  );
  const moved = parseMoved(approval?.verdict.moved);

  const [comment, setComment] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [extraId, setExtraId] = useState('');
  const [lockOpen, setLockOpen] = useState(false);

  const noteIds = [...new Set([...moved.map((s) => s.id), ...Object.keys(notes)])];

  function decideBody(outcome: ReviewStatus) {
    const pinned: ReviewNote[] = Object.entries(notes)
      .map(([specId, note]) => ({ specId, note: note.trim() }))
      .filter((n) => n.note.length > 0);
    const body: { id: string; outcome: ReviewStatus; comment?: string; notes?: ReviewNote[] } = { id: request.id, outcome };
    if (comment.trim()) body.comment = comment.trim();
    if (pinned.length > 0) body.notes = pinned;
    return body;
  }

  async function decide(outcome: ReviewStatus) {
    await post<DevReviewDecision>('/web/dev/reviews/decide', decideBody(outcome));
    toast.ok(outcome === 'approved' ? 'Approved' : 'Changes requested');
    props.onDecided();
    props.onClose();
  }

  return (
    <>
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
              <Button variant="primary" onClick={() => setLockOpen(true)}>
                {request.subsystem ? `Lock ${request.subsystem}` : 'Lock'}
              </Button>
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
            {otherBranchLine(request.branch, approval?.branch) && (
              <p className="hint" role="alert">
                {otherBranchLine(request.branch, approval?.branch)}
              </p>
            )}
            <p className="review-note">{request.note}</p>
            <p className="hint">
              Requested {new Date(request.requestedAt).toLocaleString()}
              {request.subsystem ? ` · subsystem ${request.subsystem}` : ''}
            </p>
          </section>

          <section className="stack-sm">
            <h4>Changed since the last lock</h4>
            {moved.length === 0 ? (
              <p className="hint">No spec has changed since the last lock.</p>
            ) : (
              <>
                <pre className="cmd-output">{moved.map((m) => `${m.mark} ${m.path}`).join('\n')}</pre>
                {noteIds.map((id) => (
                  <Field key={id} label={`Note on ${id}`}>
                    <textarea
                      className="syw-textarea"
                      rows={2}
                      value={notes[id] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [id]: e.target.value }))}
                    />
                  </Field>
                ))}
              </>
            )}
            <div className="list-line">
              <input
                className="syw-input"
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
            <FindingsList state={findings} />
          </section>

          <Field label="Comment">
            <textarea className="syw-textarea" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
        </div>
      </Modal>
      {lockOpen && (
        <LockModal
          fixedSubsystem={request.subsystem}
          run={async () => {
            // The decision runs the CLI's own lock first; a failed lock leaves the request pending.
            const res = await post<DevReviewDecision>('/web/dev/reviews/decide', decideBody('locked'));
            props.onDecided();
            return res.lock ?? { command: 'lock', ok: res.request.status === 'locked', output: [] };
          }}
          onLocked={() => {
            toast.ok('Locked');
            props.onClose();
          }}
          onClose={() => setLockOpen(false)}
        />
      )}
    </>
  );
}

// ── Settings cog ─────────────────────────────────────────────────────────────

const SETTINGS_COMMANDS: { id: 'generate' | 'doctor'; label: string; explain: string }[] = [
  { id: 'generate', label: 'Generate', explain: 'Refreshes the generated guides, skills and context files from the specs.' },
  { id: 'doctor', label: 'Doctor --fix', explain: 'Finishes unfinished transactions and repairs signatures, type spellings and stale guides.' },
];

function CommandRunner(props: { id: 'generate' | 'doctor'; label: string; explain: string; busy: string | null; setBusy: (id: string | null) => void }) {
  const toast = useToast();
  const [result, setResult] = useState<DevCommandResult | null>(null);

  async function run() {
    props.setBusy(props.id);
    setResult(null);
    try {
      const res = await post<DevCommandResult>('/web/dev/commands', { command: props.id });
      setResult(res);
      if (res.ok) toast.ok(`${props.label} finished`);
      else toast.bad(`${props.label} failed`);
    } catch (e) {
      toast.bad(e instanceof Error ? e.message : String(e));
    } finally {
      props.setBusy(null);
    }
  }

  return (
    <section className="settings-cmd">
      <div className="settings-cmd-row">
        <div className="settings-cmd-text">
          <strong>{props.label}</strong>
          <span className="hint">{props.explain}</span>
        </div>
        <Button size="sm" disabled={props.busy !== null} onClick={run}>
          {props.busy === props.id ? <Spinner inline /> : 'Run'}
        </Button>
      </div>
      {result && (
        <>
          <Badge tone={result.ok ? 'ok' : 'bad'}>{result.ok ? 'ok' : 'failed'}</Badge>
          <pre className="cmd-output">{result.output.join('\n') || '(no output)'}</pre>
        </>
      )}
    </section>
  );
}

/** The header cog: opens the settings panel (appearance; Generate and Doctor --fix in dev mode). */
export function SettingsCog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Fetched once the panel opens: nothing to read while it is closed.
  const status = useAsync<DevStatus | null>(
    () => (open ? get<DevStatus>('/web/dev/status').catch(() => null) : Promise.resolve(null)),
    [open],
  );
  const dev = !!status.data?.devMode;
  const triggerRef = useRef<HTMLButtonElement>(null);

  const rootRef = useRef<HTMLDivElement>(null);

  // Closes on an outside press (captured, so the canvas cannot swallow it), on Escape, from the close
  // button, and from the cog (a toggle). The theme flyout is portaled to <body>: a press in it is inside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (rootRef.current?.contains(t) || t?.closest?.('.tmenu-panel')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="hmenu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`syw-button syw-button--ghost hmenu-trigger settings-cog ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings"
        aria-haspopup="true"
        aria-expanded={open}
        data-tip="Settings"
      >
        <span className="cog" aria-hidden="true">⚙</span>
      </button>
      {open && (
        <div className="syw-popover hmenu-pop settings-pop" role="group" aria-label="Settings">
          <div className="settings-pop-head">
            <strong>Settings</strong>
            <button
              type="button"
              className="syw-button syw-button--ghost btn-sm"
              aria-label="Close settings"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              ✕
            </button>
          </div>
          <div className="settings-pop-body">
            <ThemeSections />
            {dev && SETTINGS_COMMANDS.map((c) => <CommandRunner key={c.id} {...c} busy={busy} setBusy={setBusy} />)}
          </div>
        </div>
      )}
    </div>
  );
}
