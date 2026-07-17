import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { InfoTip } from './components/InfoTip';

/**
 * Shared UI primitives for the wairon web app. Everything here is intentionally
 * un-opinionated about visuals beyond semantic class names + CSS custom
 * properties (see theme.css), so a design-system reskin is a token change, not a
 * component rewrite. Views compose these — no view hand-rolls a modal, table, or
 * async-load boilerplate.
 */

// ── Async data loading ───────────────────────────────────────────────────────

export interface Async<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
}

/** Run an async loader on mount and whenever `deps` change; expose data/loading/
 *  error plus an idempotent reload. Stale responses from a superseded load are
 *  dropped, so rapid dependency changes never flash an out-of-order result. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    loader()
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}

// ── Buttons ──────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  size?: 'sm' | 'md';
}) {
  const { children, onClick, variant = 'default', disabled, type = 'button', title, size = 'md' } = props;
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

/** A button that runs an async action, disabling itself + showing a spinner
 *  while in flight and surfacing any thrown error via onError (or swallowing it). */
export function AsyncButton(props: {
  children: ReactNode;
  action: () => Promise<void>;
  variant?: ButtonVariant;
  disabled?: boolean;
  onError?: (message: string) => void;
  size?: 'sm' | 'md';
}) {
  const { children, action, variant = 'default', disabled, onError, size = 'md' } = props;
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant={variant} disabled={disabled || busy} onClick={run} size={size}>
      {busy ? <Spinner inline /> : children}
    </Button>
  );
}

// ── Form fields ──────────────────────────────────────────────────────────────

export function Field(props: {
  label: string;
  children: ReactNode;
  hint?: string;
  /** Optional "ⓘ" hover explanation rendered next to the label. */
  info?: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {props.label}
        {props.info != null && <InfoTip>{props.info}</InfoTip>}
      </span>
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <input
      className="input"
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export function Select<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      className="input"
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value as T)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Badges ───────────────────────────────────────────────────────────────────

export function Badge(props: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent' }) {
  return <span className={`badge badge-${props.tone ?? 'neutral'}`}>{props.children}</span>;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export interface TabDef {
  id: string;
  label: string;
}

/** A horizontal tab strip with the active tab highlighted (fixing the reported
 *  "current tab not highlighted" bug). Controlled — the caller owns `active`. */
export function Tabs(props: { tabs: TabDef[]; active: string; onSelect: (id: string) => void }) {
  return (
    <div className="tabstrip" role="tablist">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === props.active}
          className={`tab ${t.id === props.active ? 'tab-active' : ''}`}
          onClick={() => props.onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

export interface Column<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  width?: string;
}

export function DataTable<Row>(props: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  empty?: ReactNode;
}) {
  if (props.rows.length === 0) {
    return <EmptyState>{props.empty ?? 'Nothing here yet.'}</EmptyState>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={props.rowKey(row)}>
              {props.columns.map((c) => (
                <td key={c.key}>{c.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

/** A centered modal dialog over a scrim. Escape and scrim-click close it. The
 *  body scroll-locks while open. Footer actions are provided by the caller. */
export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') props.onClose();
    }
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [props]);

  return (
    <div className="scrim" onMouseDown={props.onClose}>
      <div
        className={`modal ${props.wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="icon-btn" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

/** A confirm-then-act destructive control: opens a small modal, runs the action
 *  on confirm. Keeps every delete path off a bare one-click button. */
export function ConfirmButton(props: {
  label: ReactNode;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  action: () => Promise<void>;
  onDone?: () => void;
  onError?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        {props.label}
      </Button>
      {open && (
        <Modal
          title={props.title}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <AsyncButton
                variant="danger"
                onError={props.onError}
                action={async () => {
                  await props.action();
                  setOpen(false);
                  props.onDone?.();
                }}
              >
                {props.confirmLabel ?? 'Delete'}
              </AsyncButton>
            </>
          }
        >
          {props.message}
        </Modal>
      )}
    </>
  );
}

// ── Status / feedback ────────────────────────────────────────────────────────

export function Spinner(props: { inline?: boolean }) {
  return <span className={`spinner ${props.inline ? 'spinner-inline' : ''}`} aria-label="Loading" />;
}

export function EmptyState(props: { children: ReactNode }) {
  return <div className="empty-state">{props.children}</div>;
}

export function ErrorNote(props: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="error-note">
      <span>{props.children}</span>
      {props.onRetry && (
        <Button size="sm" variant="ghost" onClick={props.onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Standard async-view frame: spinner while loading, error note (with retry) on
 *  failure, otherwise the rendered children. Keeps every data view consistent. */
export function AsyncView<T>(props: { state: Async<T>; children: (data: T) => ReactNode }) {
  if (props.state.loading && props.state.data === undefined) return <div className="pad"><Spinner /></div>;
  if (props.state.error && props.state.data === undefined)
    return (
      <div className="pad">
        <ErrorNote onRetry={props.state.reload}>{props.state.error}</ErrorNote>
      </div>
    );
  if (props.state.data === undefined) return null;
  return <>{props.children(props.state.data)}</>;
}

// ── Toasts ───────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'bad';
}
interface ToastApi {
  ok: (message: string) => void;
  bad: (message: string) => void;
}
const ToastContext = createContext<ToastApi>({ ok: () => {}, bad: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider(props: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((message: string, tone: 'ok' | 'bad') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  const api: ToastApi = {
    ok: (m) => push(m, 'ok'),
    bad: (m) => push(m, 'bad'),
  };
  return (
    <ToastContext.Provider value={api}>
      {props.children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
