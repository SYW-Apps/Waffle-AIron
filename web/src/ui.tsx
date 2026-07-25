import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { InfoTip } from './components/InfoTip';
import { useRealtime } from './realtime';

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
 *  dropped, so rapid dependency changes never flash an out-of-order result.
 *  `channels` opts the load into realtime: a `change` on any listed channel
 *  triggers a (debounced) reload, so the view stays live without polling. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[], channels?: string[]): Async<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const realtime = useRealtime();

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

  // Realtime: reload when a subscribed channel changes. Coalesce a burst (several
  // channels can fire for one action) into a single reload.
  const channelKey = (channels ?? []).join('|');
  useEffect(() => {
    if (!channelKey) return;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(reload, 150);
    };
    const unsub = realtime.subscribe(channelKey.split('|'), onChange);
    return () => {
      if (debounce) clearTimeout(debounce);
      unsub();
    };
  }, [channelKey, realtime, reload]);

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
  /** Validation-rail integration (SpecsEditor's ValidationRail): marks this
   *  field as the target of an open, in-scope validation issue with a subtle
   *  outline (error/warning toned). Unused by every other caller. */
  highlight?: 'error' | 'warning';
  /** A stable `data-field` anchor a caller can scrollIntoView() by (paired
   *  with `highlight` — SpecsEditor uses both together, but either works
   *  alone). */
  fieldKey?: string;
}) {
  return (
    <label
      className={`field${props.highlight ? ` field-flag field-flag-${props.highlight}` : ''}`}
      data-field={props.fieldKey}
    >
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

export function Checkbox(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="checkbox-body">
        <span className="checkbox-label">{props.label}</span>
        {props.hint && <span className="hint">{props.hint}</span>}
      </span>
    </label>
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

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Small secondary text shown after the label (e.g. a tier or "3 profiles"). */
  hint?: string;
  /** Optional group label; options sharing a group render under one header, in
   *  first-seen order (so the caller controls group ordering). */
  group?: string;
}

/** An accessible multi-select: a chip-trigger that opens a filterable, optionally
 *  grouped checkbox list. Mirrors UnitSelect's open/close (outside-click + capture
 *  Escape) and the kit's tokens so it reads as part of the same family. Selected
 *  values with no matching option still render as removable chips, so a stored
 *  value the catalog no longer lists is never silently dropped. */
export function MultiSelect(props: {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  emptyLabel?: ReactNode;
  disabled?: boolean;
}) {
  const {
    options,
    selected,
    onChange,
    placeholder = 'Select…',
    emptyLabel = 'No options available.',
    disabled,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        e.stopPropagation();
      }
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const selectedSet = new Set(selected);
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);

  function toggle(v: string) {
    if (selectedSet.has(v)) onChange(selected.filter((x) => x !== v));
    else onChange([...selected, v]);
  }

  // Group preserving first-seen order; ungrouped options render first (no header).
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, MultiSelectOption[]>();
    for (const o of options) {
      const g = o.group ?? '';
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g)!.push(o);
    }
    return order.map((g) => ({ group: g, options: map.get(g)! }));
  }, [options]);

  const q = query.trim().toLowerCase();
  const matches = (o: MultiSelectOption) =>
    !q ||
    o.label.toLowerCase().includes(q) ||
    o.value.toLowerCase().includes(q) ||
    (o.group ?? '').toLowerCase().includes(q);

  return (
    <div className="msel" ref={rootRef}>
      <button
        type="button"
        className="input msel-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {selected.length === 0 ? (
          <span className="msel-ph">{placeholder}</span>
        ) : (
          <span className="msel-chips">
            {selected.map((v) => (
              <span key={v} className="msel-chip">
                {byValue.get(v)?.label ?? v}
                {!disabled && (
                  <span
                    className="msel-chip-x"
                    role="button"
                    aria-label={`Remove ${byValue.get(v)?.label ?? v}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(v);
                    }}
                  >
                    ×
                  </span>
                )}
              </span>
            ))}
          </span>
        )}
        <span className="msel-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && !disabled && (
        <div className="msel-pop" role="listbox" aria-multiselectable="true">
          {options.length > 8 && (
            <input
              className="input msel-search"
              autoFocus
              placeholder="Filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="msel-list">
            {options.length === 0 ? (
              <div className="msel-empty">{emptyLabel}</div>
            ) : (
              groups.map(({ group, options: opts }) => {
                const visible = opts.filter(matches);
                if (visible.length === 0) return null;
                return (
                  <div key={group || '_ungrouped'} className="msel-group">
                    {group && <div className="msel-group-head">{group}</div>}
                    {visible.map((o) => (
                      <label key={o.value} className={`msel-opt ${selectedSet.has(o.value) ? 'sel' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selectedSet.has(o.value)}
                          onChange={() => toggle(o.value)}
                        />
                        <span className="msel-opt-body">
                          <span className="msel-opt-label">{o.label}</span>
                          {o.hint && <span className="msel-opt-hint">{o.hint}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
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
