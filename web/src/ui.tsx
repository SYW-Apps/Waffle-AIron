import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SywButton, SywTabs } from '@syw/design-react';
import { InfoTip } from './components/InfoTip';
import { useRealtime } from './realtime';

/**
 * Shared UI primitives for the wairon web app, built on the SYW Design System
 * (.syw-* classes + the --syw-* semantic tokens, which the theme engine bridges
 * onto — see theme/sywBridge.ts). Views compose these — no view hand-rolls a
 * modal, table, or async-load boilerplate. Product-only layout lives in theme.css.
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
    <SywButton
      type={type}
      variant={variant}
      className={size === 'sm' ? 'btn-sm' : ''}
      onClick={onClick}
      disabled={disabled}
      data-tip={title}
    >
      {children}
    </SywButton>
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
   *  outline (error/warning toned; a notice gets a quiet neutral tone, never
   *  the warning one). Unused by every other caller. */
  highlight?: 'error' | 'warning' | 'notice';
  /** A stable `data-field` anchor a caller can scrollIntoView() by (paired
   *  with `highlight` — SpecsEditor uses both together, but either works
   *  alone). */
  fieldKey?: string;
}) {
  return (
    <label
      className={`syw-field${props.highlight ? ` field-flag field-flag-${props.highlight}` : ''}`}
      data-field={props.fieldKey}
    >
      <span className="syw-field__label field-label">
        {props.label}
        {props.info != null && <InfoTip>{props.info}</InfoTip>}
      </span>
      {props.children}
      {props.hint && <span className="syw-field__help">{props.hint}</span>}
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
      className="syw-input"
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
      className="syw-select"
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
        // Consume it: an enclosing modal <dialog> must not also close on this Escape.
        e.preventDefault();
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
        className="syw-input msel-trigger"
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
              <span key={v} className="syw-chip msel-chip">
                {byValue.get(v)?.label ?? v}
                {!disabled && (
                  <span
                    className="msel-chip-x"
                    role="button"
                    aria-label={`Remove ${byValue.get(v)?.label ?? v}`}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        toggle(v);
                      }
                    }}
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
        <div className="syw-popover msel-pop" role="listbox" aria-multiselectable="true">
          {options.length > 8 && (
            <input
              className="syw-input msel-search"
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
  return <span className={`syw-chip badge badge-${props.tone ?? 'neutral'}`}>{props.children}</span>;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export interface TabDef {
  id: string;
  label: string;
  disabled?: boolean;
}

/** DOM ids for a tab and its panel, so aria-controls / aria-labelledby resolve. */
export const tabIds = (idBase: string, id: string) => ({
  tab: `${idBase}-tab-${id}`,
  panel: `${idBase}-panel-${id}`,
});

/** A horizontal tab strip (DS SywTabs: roving focus, arrow/Home/End keys,
 *  disabled skipping) with the active tab selected. Controlled — the caller owns
 *  `active`. Pass `idBase` and render the body in a `TabPanel` with the same
 *  base to associate tabs and panel; omit it for a strip that only navigates. */
export function Tabs(props: {
  tabs: TabDef[];
  active: string;
  onSelect: (id: string) => void;
  idBase?: string;
  label?: string;
  className?: string;
}) {
  const auto = useId();
  const base = props.idBase ?? auto;
  const hasPanel = props.idBase !== undefined;
  return (
    <SywTabs
      aria-label={props.label ?? 'Sections'}
      className={props.className}
      value={props.active}
      onChange={(v) => props.onSelect(v)}
      tabs={props.tabs.map((t) => ({
        value: t.id,
        label: t.label,
        disabled: t.disabled,
        id: tabIds(base, t.id).tab,
        // Navigation-only strips have no panel element to control.
        panelId: (hasPanel ? tabIds(base, t.id).panel : undefined) as unknown as string,
      }))}
    />
  );
}

/** The panel for the active tab of a Tabs strip that shares `idBase`. */
export function TabPanel(props: { idBase: string; id: string; children: ReactNode }) {
  const ids = tabIds(props.idBase, props.id);
  return (
    <div className="tab-panel" role="tabpanel" id={ids.panel} aria-labelledby={ids.tab}>
      {props.children}
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

/** A modal dialog: the native <dialog class="syw-dialog"> opened with
 *  showModal() (top layer, inert background, focus trap, Escape fires `cancel`).
 *  Mounted-while-open, like every caller already uses it: on mount it opens, on
 *  unmount it closes and returns focus to the invoker (when still connected).
 *  A press on the backdrop closes it; footer actions come from the caller. */
export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (invoker && invoker.isConnected) invoker.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`syw-dialog${props.wide ? ' dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Escape: let the app decide (a busy form may refuse to close).
        e.preventDefault();
        onCloseRef.current();
      }}
      onMouseDown={(e) => {
        // Only a press on the backdrop itself (the dialog's own padding is 0).
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div className="syw-dialog__header">
        <h3 className="syw-dialog__title" id={titleId}>
          {props.title}
        </h3>
        <button type="button" className="syw-button syw-button--ghost icon-btn" aria-label="Close" onClick={props.onClose}>
          ×
        </button>
      </div>
      <div className="syw-dialog__body">{props.children}</div>
      {props.footer && <div className="syw-dialog__footer">{props.footer}</div>}
    </dialog>
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
  return <span className={`spinner ${props.inline ? 'spinner-inline' : ''}`} role="status" aria-label="Loading" />;
}

export function EmptyState(props: { children: ReactNode }) {
  return (
    <div className="syw-empty">
      <div className="syw-empty__description">{props.children}</div>
    </div>
  );
}

export function ErrorNote(props: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="syw-alert syw-alert--danger" role="alert">
      <span aria-hidden="true">⚠</span>
      <div className="alert-line">
        <span>{props.children}</span>
        {props.onRetry && (
          <Button size="sm" variant="ghost" onClick={props.onRetry}>
            Retry
          </Button>
        )}
      </div>
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
  const stackRef = useRef<HTMLDivElement | null>(null);
  const push = useCallback((message: string, tone: 'ok' | 'bad') => {
    const id = nextId.current++;
    // Errors stay until dismissed (so a failure is never missed); routine
    // messages time out. Both are dismissible.
    setToasts((t) => [...t, { id, message, tone }]);
    if (tone === 'ok') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const api = useMemo<ToastApi>(() => ({ ok: (m) => push(m, 'ok'), bad: (m) => push(m, 'bad') }), [push]);

  // The stack is a manual popover so it enters the TOP LAYER: a toast raised
  // while a modal dialog is open must render above the dialog and its backdrop.
  // Re-showing on each change moves it above any dialog opened since.
  useEffect(() => {
    const el = stackRef.current;
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      if (toasts.length > 0) el.showPopover();
    } catch {
      /* popover API unavailable: the fixed stack still renders in the page layer */
    }
  }, [toasts]);

  return (
    <ToastContext.Provider value={api}>
      {props.children}
      <div className="toast-stack" popover="manual" ref={stackRef} aria-label="Notifications">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`syw-alert syw-alert--${t.tone === 'ok' ? 'success' : 'danger'} toast`}
            role={t.tone === 'ok' ? 'status' : 'alert'}
          >
            <span aria-hidden="true">{t.tone === 'ok' ? '✓' : '⚠'}</span>
            <div className="alert-line">
              <span>{t.message}</span>
              <button
                type="button"
                className="syw-button syw-button--ghost icon-btn"
                aria-label="Dismiss notification"
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
