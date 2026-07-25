import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { asList, get, mcpCall, post } from '../api';
import {
  AsyncButton,
  AsyncView,
  Badge,
  Checkbox,
  EmptyState,
  Field,
  Select,
  Spinner,
  TextInput,
  useAsync,
  useToast,
  type Async,
} from '../ui';
import type { AvailableProfile } from '../types';

/**
 * Stage F — the project Specs VALUE-editor.
 *
 * A LEFT spec picker (the project's spec tree, from /web/graph) + a RIGHT field
 * editor. Users edit spec field VALUES only — never structure: selects wherever a
 * field is a closed set, combobox where it's known-plus-free, free text only for
 * genuinely free-form fields. No layer membership, dependency, ref, narrative
 * flow, or add/remove of methods/params/fields is touched.
 *
 * Reads/writes ride the MCP data plane directly (mcpCall → sdd_get_spec /
 * sdd_update_spec / sdd_validate_tree); the only server route this view needs
 * beyond that is /web/projects/config (projectType + lock), which it degrades
 * around when absent.
 */

// ── Kinds ────────────────────────────────────────────────────────────────────

type SpecKind = 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type';

interface Selected {
  kind: SpecKind;
  id: string;
  label: string;
}

// ── Closed-enum vocabularies (mirrored from src/models/specs.ts + project.ts) ──

const STATUS = ['draft', 'design', 'complete'];
const COMPONENT_TYPE = [
  'Portal', 'Orchestrator', 'Supervisor', 'Actor', 'Store', 'Index', 'Registry',
  'Adapter', 'Observer', 'Specialist', 'View', 'Repository', 'Gateway',
  'FeatureComponent', 'RouterComponent',
];
const PORTAL_TYPE = ['HTTP_API', 'gRPC', 'GraphQL', 'MessageBus', 'CLI', 'NamedPipe', 'IPC', 'Custom'];
const DURABILITY = ['ram-projection', 'durable', 'read-through', 'cache'];
const DESIGN_DEPTH = ['components', 'interfaces', 'implementations', 'narratives'];
const METHOD_EFFECT = ['read', 'write'];
const TRANSPORT = ['HTTP', 'gRPC', 'GraphQL', 'MessageBus', 'NamedPipe', 'IPC', 'CLI', 'Custom'];
const HTTP_METHOD = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
const GRAPHQL_OP = ['query', 'mutation', 'subscription'];
const MB_DIRECTION = ['subscribe', 'publish'];
const PUBLIC_INTERFACE_TYPE = ['REST', 'GraphQL', 'MessageBus', 'RPC', 'Custom'];
const AUDIENCE = ['project', 'department', 'instance', 'partner', 'external'];
const NARRATIVE_DETAIL = ['full', 'calls-only', 'intent'];
const CONFORMANCE = ['declared', 'anchored', 'off'];
const EXTERNAL_LINK_TYPE = ['implementation', 'informative'];
const AUTH_SCHEME = ['none', 'apiKey', 'bearer', 'basic', 'oauth2', 'openIdConnect', 'custom'];
const AUTH_IN = ['header', 'query', 'cookie'];
const OAUTH_FLOW = ['authorizationCode', 'clientCredentials', 'implicit', 'password'];
const TYPE_KIND = ['entity', 'value-object'];
const TYPE_FIELD_KEY = ['primary', 'unique', 'foreign'];
const BUILTIN_GUARANTEES = ['idempotent', 'atomic', 'transactional', 'exactly-once'];
const PROJECT_KINDS = ['fullstack', 'system-of-systems', 'monorepo'];
const BUILTIN_PROFILES = [
  'backend', 'frontend-reactive', 'frontend-controller', 'lowlevel-os',
  'game-ecs', 'realtime-embedded', 'plc-cyclic',
];
const PRIMITIVES = [
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'any', 'unknown',
  'object', 'Date', 'bigint', 'Buffer', 'Promise<void>',
];

/** Top-level scalar/enum fields editable per kind (values only). */
const SCALAR_FIELDS: Record<SpecKind, string[]> = {
  system: ['vision'],
  subsystem: ['name', 'description', 'status', 'profile', 'designDepth', 'targetLanguage'],
  component: ['name', 'description', 'status', 'componentType', 'portalType', 'basePath', 'durability'],
  interface: ['name', 'description'],
  implementation: ['name', 'description', 'status', 'detail', 'conformance'],
  type: ['name', 'description', 'kind'],
};

/** Optional enum fields the delta merge cannot UNSET (JSON drops undefined; the
 *  merge spreads, so '' would fail schema). Changing to a real value works;
 *  clearing a previously-set value is a no-op (documented). */
const OPTIONAL_ENUM_FIELDS = new Set(['profile', 'designDepth', 'portalType', 'durability', 'detail', 'conformance']);

/**
 * Validation-rail field map — `sdd_validate_tree` issue code → the editable
 * field (as used with `Field`'s `fieldKey`/`highlight` props below) it points
 * at. ONLY curated codes with a VERIFIED real field in one of the panels
 * below belong here — this is deliberately partial, not exhaustive: codes
 * like EXCESSIVE_DEPENDENCIES/GOD_COMPONENT (dependsOn), UNKNOWN_PATTERN_REF
 * (patterns), and MISSING_SOURCE_PATH/MISSING_SOURCE_FILE/
 * SOURCE_PATH_ESCAPES_ROOT (sourcePath) were considered and DROPPED — this is
 * a values-only editor (see the module doc comment), and none of those
 * fields have an editable control anywhere in this file. Add an entry only
 * after confirming the target field really renders for that spec kind.
 */
const CODE_FIELD_MAP: Record<string, string> = {
  DESCRIPTION_TOO_SHORT: 'description',
  MISSING_DESCRIPTION: 'description',
  PROFILE_FORBIDDEN_STEREOTYPE: 'componentType',
  PROFILE_DISCOURAGED_STEREOTYPE: 'componentType',
  FRONTEND_STEREOTYPE_IN_BACKEND: 'componentType',
  BACKEND_STEREOTYPE_IN_FRONTEND: 'componentType',
  PLC_CYCLIC_CONCURRENCY_VIOLATION: 'componentType',
  MISSING_DURABILITY: 'durability',
  UNKNOWN_PROFILE: 'profile',
  // public-surface.ts always attaches these to the declaring subsystem, whose
  // editor renders one "Public interfaces" group (not addressable per-entry —
  // the issue doesn't say which entry, so the whole group is flagged).
  PUBLIC_INTERFACE_UNBOUND: 'publicInterfaces',
  PUBLIC_INTERFACE_INVALID_COMPONENT: 'publicInterfaces',
  PUBLIC_INTERFACE_FOREIGN_COMPONENT: 'publicInterfaces',
  PUBLIC_INTERFACE_TYPE_MISMATCH: 'publicInterfaces',
  PUBLIC_INTERFACE_INVALID_INTERFACE: 'publicInterfaces',
  PUBLIC_INTERFACE_EVENT_MISTYPED: 'publicInterfaces',
};

/** Highest-severity flag per field, scoped to ONE spec's issues (the caller
 *  pre-filters by specId — see SpecsTab's openSpecFieldFlags). */
type FieldFlags = Map<string, 'error' | 'warning'>;
const EMPTY_FIELD_FLAGS: FieldFlags = new Map();

// ── Graph (picker source) ──────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  label: string;
  kind: string; // 'project' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type'
  level: number;
  parentId?: string;
}
interface GraphEdge {
  from: string;
  to: string;
  edgeKind: string; // 'contains' | 'owns' | 'depends_on'
}
interface Graph {
  nodes: GraphNode[];
  edges?: GraphEdge[];
}

interface ProjectConfigResp {
  projectType: string;
  locked?: boolean;
  /** "builtin" or the contributing pack's name — where the recorded projectType
   *  currently resolves from. */
  profileSource?: string;
  /** False means the recorded projectType resolves to nothing, so its doctrine
   *  is NOT being applied. */
  profileResolvable?: boolean;
  /** Set on a save that had to vendor a pack to make the profile resolvable. */
  adoptedPackName?: string;
  /** Recorded selection ids that aren't the governing project type — they
   *  belong on individual subsystems instead. */
  unappliedProfileIds?: string[];
  /** Subsystems declaring their own profile, which the project-level one does
   *  not govern. */
  overridingSubsystemIds?: string[];
}

const byLabel = (a: GraphNode, b: GraphNode) => a.label.localeCompare(b.label);
const jeq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

// ── Small controls ─────────────────────────────────────────────────────────────

/** A closed-enum <select>, optionally with a leading "none" for optional fields. */
function EnumSelect(props: {
  value: string | undefined;
  onChange: (v: string) => void;
  options: string[];
  allowNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
}) {
  const opts = [
    ...(props.allowNone ? [{ value: '', label: props.noneLabel ?? '— none —' }] : []),
    ...props.options.map((o) => ({ value: o, label: o })),
  ];
  return <Select value={props.value ?? ''} onChange={props.onChange} options={opts} disabled={props.disabled} />;
}

let comboSeq = 0;
/** A known-plus-free text field: an <input> backed by a <datalist> of suggestions
 *  that never restricts what can be typed. */
function Combobox(props: {
  value: string | undefined;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const listId = useMemo(() => `dl-${++comboSeq}`, []);
  return (
    <>
      <input
        className="input"
        list={listId}
        value={props.value ?? ''}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <datalist id={listId}>
        {props.suggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
    </>
  );
}

/** An open-set editor: removable chips + Enter-to-add + one-click builtin adds. */
function TagInput(props: {
  values: string[];
  onChange: (v: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const values = props.values ?? [];
  const add = (raw: string) => {
    const v = raw.trim();
    if (v && !values.includes(v)) props.onChange([...values, v]);
    setText('');
  };
  const remove = (v: string) => props.onChange(values.filter((x) => x !== v));
  const unused = (props.suggestions ?? []).filter((s) => !values.includes(s));
  return (
    <div className="taginput">
      {values.length > 0 && (
        <span className="msel-chips">
          {values.map((v) => (
            <span key={v} className="msel-chip">
              {v}
              {!props.disabled && (
                <span className="msel-chip-x" role="button" aria-label={`Remove ${v}`} onClick={() => remove(v)}>×</span>
              )}
            </span>
          ))}
        </span>
      )}
      <input
        className="input"
        value={text}
        placeholder={props.placeholder ?? 'Type and press Enter…'}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          }
        }}
      />
      {unused.length > 0 && !props.disabled && (
        <div className="chip-row">
          {unused.map((s) => (
            <button key={s} type="button" className="btn btn-ghost btn-sm" onClick={() => add(s)}>+ {s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A vertical list of free-text lines with add/remove — for open PROSE lists
 *  (L0 boundaries, global requirements) whose items may be a bare string OR a
 *  shaped object. getText/setText read+write the right sub-field so an item's
 *  existing shape (and any fields we don't surface) survives the round-trip. */
function TextListEditor(props: {
  items: any[];
  onChange: (items: any[]) => void;
  getText: (it: any) => string;
  setText: (it: any, text: string) => any;
  placeholder?: string;
  addLabel?: string;
  disabled?: boolean;
}) {
  const items = props.items ?? [];
  const update = (i: number, text: string) => props.onChange(items.map((it, j) => (j === i ? props.setText(it, text) : it)));
  const remove = (i: number) => props.onChange(items.filter((_, j) => j !== i));
  return (
    <div className="stack-sm">
      {items.map((it, i) => (
        <div key={i} className="list-line">
          <input
            className="input"
            value={props.getText(it)}
            placeholder={props.placeholder}
            disabled={props.disabled}
            onChange={(e) => update(i, e.target.value)}
          />
          {!props.disabled && (
            <button type="button" className="icon-btn" aria-label="Remove" title="Remove" onClick={() => remove(i)}>×</button>
          )}
        </div>
      ))}
      {!props.disabled && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => props.onChange([...items, ''])}>
          + {props.addLabel ?? 'Add'}
        </button>
      )}
    </div>
  );
}

/** Editor for a component's opaque external links — each a { url, type, label? }.
 *  An `implementation` link is the external source-of-record (satisfies the source
 *  requirement); `informative` links are context. wairon never fetches these. */
function ExternalLinksEditor(props: { links: any[]; onChange: (links: any[]) => void }) {
  const links = props.links ?? [];
  const update = (i: number, patch: Record<string, unknown>) =>
    props.onChange(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => props.onChange(links.filter((_, j) => j !== i));
  return (
    <div className="stack-sm">
      {links.map((l, i) => (
        <div key={i} className="sub-card">
          <div className="row-form">
            <Field label="URL"><TextInput value={l.url ?? ''} onChange={(v) => update(i, { url: v })} placeholder="https://…" /></Field>
            <Field label="Type" info="An 'implementation' link is the external source-of-record (it satisfies the source requirement); 'informative' is context only.">
              <EnumSelect value={l.type ?? 'informative'} onChange={(v) => update(i, { type: v })} options={EXTERNAL_LINK_TYPE} />
            </Field>
            <Field label="Label"><TextInput value={l.label ?? ''} onChange={(v) => update(i, { label: v })} placeholder="(optional)" /></Field>
            <div className="row-form-action">
              <button type="button" className="icon-btn" aria-label="Remove link" title="Remove" onClick={() => remove(i)}>×</button>
            </div>
          </div>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => props.onChange([...links, { url: '', type: 'informative' }])}>
        + external link
      </button>
    </div>
  );
}

/** Editor for a Portal's auth (PortalAuth) — projected into the OpenAPI
 *  securitySchemes/security. 'none' means no security. Per-scheme fields appear
 *  as the scheme changes. (Switching schemes may leave harmless stale fields the
 *  codec ignores — it dispatches on `scheme`.) */
function PortalAuthEditor(props: { auth: any; onChange: (auth: any) => void }) {
  const a = props.auth ?? { scheme: 'none' };
  const scheme = a.scheme ?? 'none';
  const set = (patch: Record<string, unknown>) => props.onChange({ ...a, ...patch });
  const scopes: any[] = a.scopes ?? [];
  const setScopes = (v: any[]) => set({ scopes: v });
  return (
    <div className="stack-sm">
      <Field label="Auth scheme" hint="Default 'none' → no security. Portals with different auth must be separate components.">
        <EnumSelect value={scheme} onChange={(s) => props.onChange(s === 'none' ? { scheme: 'none' } : { ...a, scheme: s })} options={AUTH_SCHEME} />
      </Field>
      {scheme === 'apiKey' && (
        <div className="row-form">
          <Field label="In"><EnumSelect value={a.in ?? 'header'} onChange={(v) => set({ in: v })} options={AUTH_IN} /></Field>
          <Field label="Name"><TextInput value={a.name ?? ''} onChange={(v) => set({ name: v })} placeholder="X-API-Key" /></Field>
        </div>
      )}
      {scheme === 'bearer' && (
        <Field label="Bearer format"><TextInput value={a.bearerFormat ?? ''} onChange={(v) => set({ bearerFormat: v })} placeholder="JWT" /></Field>
      )}
      {scheme === 'oauth2' && (
        <>
          <Field label="Flow"><EnumSelect value={a.flow ?? 'authorizationCode'} onChange={(v) => set({ flow: v })} options={OAUTH_FLOW} /></Field>
          <Field label="Authorization URL"><TextInput value={a.authorizationUrl ?? ''} onChange={(v) => set({ authorizationUrl: v })} placeholder="https://…/authorize" /></Field>
          <Field label="Token URL"><TextInput value={a.tokenUrl ?? ''} onChange={(v) => set({ tokenUrl: v })} placeholder="https://…/token" /></Field>
          <Field label="Refresh URL"><TextInput value={a.refreshUrl ?? ''} onChange={(v) => set({ refreshUrl: v })} placeholder="(optional)" /></Field>
          <span className="field-label">Scopes</span>
          {scopes.map((s, i) => (
            <div key={i} className="row-form">
              <Field label="Scope"><TextInput value={s.name ?? ''} onChange={(v) => setScopes(scopes.map((x, j) => (j === i ? { ...x, name: v } : x)))} /></Field>
              <Field label="Description"><TextInput value={s.description ?? ''} onChange={(v) => setScopes(scopes.map((x, j) => (j === i ? { ...x, description: v } : x)))} /></Field>
              <div className="row-form-action"><button type="button" className="icon-btn" aria-label="Remove scope" onClick={() => setScopes(scopes.filter((_, j) => j !== i))}>×</button></div>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScopes([...scopes, { name: '', description: '' }])}>+ scope</button>
        </>
      )}
      {scheme === 'openIdConnect' && (
        <Field label="OpenID Connect URL"><TextInput value={a.openIdConnectUrl ?? ''} onChange={(v) => set({ openIdConnectUrl: v })} placeholder="https://…/.well-known/openid-configuration" /></Field>
      )}
      {scheme === 'custom' && (
        <div className="row-form">
          <Field label="In"><EnumSelect value={a.in ?? 'header'} onChange={(v) => set({ in: v })} options={AUTH_IN} /></Field>
          <Field label="Name"><TextInput value={a.name ?? ''} onChange={(v) => set({ name: v })} placeholder="Authorization" /></Field>
        </div>
      )}
      {scheme !== 'none' && (
        <div className="row-form">
          <Field label="Description"><TextInput value={a.description ?? ''} onChange={(v) => set({ description: v })} placeholder="(optional)" /></Field>
          <Field label="Format example"><TextInput value={a.example ?? ''} onChange={(v) => set({ example: v })} placeholder="e.g. Bearer <token>" /></Field>
        </div>
      )}
    </div>
  );
}

/** The focused spec's scope for the validation rail — either the open
 *  component's whole unit (component + its interface(s) + implementation(s),
 *  the same unit ComponentUnitEditor tabs between) or, for a subsystem/type/
 *  system selection, just that one id. Null means nothing is selected, so
 *  the rail shows everything (unchanged from before this feature). */
interface RailScope {
  ids: Set<string>;
  /** For the "N on this <noun>" header line. */
  noun: 'component' | 'subsystem' | 'type' | 'system';
}

/** True when `specId` belongs to `scope` — either it names a scoped spec
 *  directly, or it is a synthetic "<parentId>.<memberName>" id a few rule
 *  codes use to point at an interface method / type field / type method
 *  (complexity.ts) whose PARENT is in scope. Plain ids never otherwise
 *  contain '.' (subproject namespacing uses '::'), so this split is safe. */
function issueInScope(specId: string | undefined, scope: RailScope): boolean {
  if (!specId) return false;
  if (scope.ids.has(specId)) return true;
  const dot = specId.lastIndexOf('.');
  return dot > 0 && scope.ids.has(specId.slice(0, dot));
}

/** Resolve a raw specId to a graph node for chip display: exact id match
 *  first, then (for the same "<parentId>.<memberName>" composite ids
 *  issueInScope() understands) fall back to the parent node, surfacing the
 *  member name as a suffix. Returns null when neither resolves — some issues
 *  (e.g. a project-level UNKNOWN_PROFILE) carry no specId at all, and a few
 *  reference ids the currently loaded graph doesn't carry. */
function resolveSpecRef(
  specId: string,
  nodes: GraphNode[],
): { kind: SpecKind; id: string; label: string; suffix?: string } | null {
  const normKind = (k: string): SpecKind => (k === 'project' ? 'system' : (k as SpecKind));
  const exact = nodes.find((n) => n.id === specId);
  if (exact) return { kind: normKind(exact.kind), id: exact.id, label: exact.label };
  const dot = specId.lastIndexOf('.');
  if (dot > 0) {
    const parent = nodes.find((n) => n.id === specId.slice(0, dot));
    if (parent) return { kind: normKind(parent.kind), id: parent.id, label: parent.label, suffix: specId.slice(dot + 1) };
  }
  return null;
}

/** The affected-spec affordance on a finding row: a clickable chip naming the
 *  spec's kind + human label when the graph resolves it, else a plain,
 *  non-interactive "id · <raw id>" fallback (never guess a kind to navigate
 *  to). Reuses the exact URL-tracked selection mechanism the tree picker
 *  uses (onSelectSpec), including its '::' → '/' qualified-id mapping. */
function IssueSpecChip(props: { specId: string; nodes: GraphNode[]; onSelectSpec: (sel: { kind: string; id: string }) => void }) {
  const ref = resolveSpecRef(props.specId, props.nodes);
  if (!ref) {
    return <span className="badge badge-neutral finding-chip-unresolved" title={props.specId}>id · {props.specId}</span>;
  }
  return (
    <button
      type="button"
      className="badge badge-accent finding-chip"
      title={props.specId}
      onClick={() => props.onSelectSpec({ kind: ref.kind, id: ref.id })}
    >
      {ref.kind} · {ref.label}{ref.suffix ? ` · ${ref.suffix}` : ''}
    </button>
  );
}

const SCOPE_NOUN_LABEL: Record<RailScope['noun'], string> = {
  component: 'component',
  subsystem: 'subsystem',
  type: 'type',
  system: 'system',
};

/** The tree-wide validation results rail (the whitespace to the right of the
 *  editor). Validation is a WHOLE-TREE concern, so it lives at the tab level —
 *  running it here (not per-spec) keeps results visible as you move between
 *  specs, and renders them beside the form instead of pushing it down.
 *
 *  Scoped to the focused spec by default (with an honest "N elsewhere" count
 *  and a show-all escape hatch) — see SpecsTab's `scope`/`showAll`. Each
 *  finding names its affected spec via a clickable chip, and — when the
 *  issue's code maps to a real field on whatever spec is CURRENTLY open
 *  (CODE_FIELD_MAP, cross-checked against `openSpecId`) — the message itself
 *  is clickable to scroll to + highlight that field. */
function ValidationRail(props: {
  validation: { errors: any[]; warnings: any[] } | null;
  onValidate: () => Promise<void>;
  nodes: GraphNode[];
  onSelectSpec: (sel: { kind: string; id: string }) => void;
  /** Null when nothing is selected — show everything, no scoping UI. */
  scope: RailScope | null;
  showAll: boolean;
  onToggleShowAll: () => void;
  /** The exact spec currently open in the editor (selected?.id) — a finding's
   *  message is only scroll-clickable when it matches this exactly (its
   *  mapped field only actually renders on THIS spec's panel). */
  openSpecId: string | null;
  onRequestScroll: (field: string) => void;
}) {
  const toast = useToast();
  const v = props.validation;
  const total = v ? v.errors.length + v.warnings.length : 0;
  const inScope = (i: any) => !props.scope || issueInScope(i.specId, props.scope);
  const scopedErrors = v ? v.errors.filter(inScope) : [];
  const scopedWarnings = v ? v.warnings.filter(inScope) : [];
  const inScopeCount = scopedErrors.length + scopedWarnings.length;
  const elsewhereCount = total - inScopeCount;
  const showingAll = !props.scope || props.showAll;
  const displayedErrors = showingAll ? (v?.errors ?? []) : scopedErrors;
  const displayedWarnings = showingAll ? (v?.warnings ?? []) : scopedWarnings;

  const Finding = (i: any, kindLabel: 'error' | 'warn', key: string) => {
    const field = CODE_FIELD_MAP[i.code];
    const scrollable = !!field && !!props.openSpecId && i.specId === props.openSpecId;
    return (
      <li key={key} className={`finding f-${kindLabel}`}>
        <div className="finding-row">
          <span className={kindLabel === 'error' ? 'err' : 'badge-warn'} style={kindLabel === 'warn' ? { padding: 0 } : undefined}>{kindLabel}</span>
          {i.code ? <code className="subtle">{i.code}</code> : null}
        </div>
        <div
          className={scrollable ? 'finding-msg finding-msg-clickable' : 'finding-msg'}
          role={scrollable ? 'button' : undefined}
          onClick={scrollable ? () => props.onRequestScroll(field) : undefined}
          title={scrollable ? 'Jump to this field' : undefined}
        >
          {i.message}
        </div>
        {i.specId && (
          <div className="finding-chip-row">
            <IssueSpecChip specId={i.specId} nodes={props.nodes} onSelectSpec={props.onSelectSpec} />
          </div>
        )}
      </li>
    );
  };

  return (
    <aside className="spec-validation">
      <div className="spec-validation-head">
        <span className="field-label">Validation</span>
        <AsyncButton variant="ghost" action={props.onValidate} onError={toast.bad}>Validate tree</AsyncButton>
      </div>
      {!v && <p className="hint">Run a tree validation to list this project's errors and warnings here.</p>}
      {v && total === 0 && <Badge tone="ok">clean — no errors or warnings</Badge>}
      {v && total > 0 && (
        <>
          {props.scope && (
            <div className="spec-validation-scope">
              <span className="hint">
                {inScopeCount} on this {SCOPE_NOUN_LABEL[props.scope.noun]} · {elsewhereCount} elsewhere
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={props.onToggleShowAll}>
                {props.showAll ? 'Show scoped' : 'Show all'}
              </button>
            </div>
          )}
          <div className="spec-validation-counts">
            {displayedErrors.length > 0 && <Badge tone="bad">{displayedErrors.length} errors</Badge>}{' '}
            {displayedWarnings.length > 0 && <Badge tone="warn">{displayedWarnings.length} warnings</Badge>}
            {displayedErrors.length === 0 && displayedWarnings.length === 0 && (
              <Badge tone="ok">clean — no issues on this {SCOPE_NOUN_LABEL[props.scope!.noun]}</Badge>
            )}
          </div>
          <ul className="finding-list">
            {displayedErrors.map((i, n) => Finding(i, 'error', `e${n}`))}
            {displayedWarnings.map((i, n) => Finding(i, 'warn', `w${n}`))}
          </ul>
        </>
      )}
    </aside>
  );
}

/** A grouped <select> (native optgroups) — used where options come from the
 *  profile catalog grouped by source. */
function GroupedSelect(props: {
  value: string;
  onChange: (v: string) => void;
  groups: { label: string; options: { value: string; label: string }[] }[];
  includeNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
}) {
  return (
    <select className="input" value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
      {props.includeNone && <option value="">{props.noneLabel ?? '(none)'}</option>}
      {props.groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/** Group AvailableProfile[] by source (builtin first), for a GroupedSelect. */
function profileGroups(profiles: AvailableProfile[]): { label: string; options: { value: string; label: string }[] }[] {
  const bySource = new Map<string, { value: string; label: string }[]>();
  const order: string[] = [];
  for (const p of [...profiles].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = p.source === 'builtin' ? 'Built-in' : p.source;
    if (!bySource.has(key)) {
      bySource.set(key, []);
      order.push(key);
    }
    bySource.get(key)!.push({ value: p.id, label: p.family ? `${p.id} (${p.family})` : p.id });
  }
  // Built-in first, then packs alphabetically.
  order.sort((a, b) => (a === 'Built-in' ? -1 : b === 'Built-in' ? 1 : a.localeCompare(b)));
  return order.map((label) => ({ label, options: bySource.get(label)! }));
}

/** Ensure the current value is selectable even if the catalog no longer lists it. */
function withCurrent(groups: { label: string; options: { value: string; label: string }[] }[], value: string) {
  if (!value) return groups;
  const known = groups.some((g) => g.options.some((o) => o.value === value));
  return known ? groups : [{ label: 'Current', options: [{ value, label: value }] }, ...groups];
}

// ── Delta builder ───────────────────────────────────────────────────────────────

function scalarDelta(kind: SpecKind, orig: Record<string, unknown>, draft: Record<string, unknown>): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  for (const f of SCALAR_FIELDS[kind]) {
    const nv = draft[f];
    const ov = orig[f];
    if (nv === ov) continue;
    if ((nv === '' || nv === undefined) && ov === undefined) continue; // no-op
    if (nv === undefined) continue;
    if (nv === '' && OPTIONAL_ENUM_FIELDS.has(f)) continue; // merge cannot unset optional enums
    delta[f] = nv;
  }
  return delta;
}

/** Interface method value deltas (merged by name; nested arrays/objects replace
 *  wholesale, so params/guarantees/endpoint are sent complete). */
function interfaceMethodsDelta(orig: any, draft: any): any[] {
  const out: any[] = [];
  for (const dm of draft.methods ?? []) {
    const om = (orig.methods ?? []).find((m: any) => m.name === dm.name);
    if (!om) continue;
    const ch: any = {};
    if (dm.description !== om.description) ch.description = dm.description;
    if (dm.signature !== om.signature) ch.signature = dm.signature;
    if (dm.returns !== om.returns) ch.returns = dm.returns;
    if ((dm.effect ?? '') !== (om.effect ?? '') && dm.effect) ch.effect = dm.effect;
    if (!jeq(dm.guarantees ?? [], om.guarantees ?? [])) ch.guarantees = dm.guarantees ?? [];
    if (!jeq(dm.params ?? [], om.params ?? [])) ch.params = dm.params ?? [];
    if (!jeq(dm.endpoint, om.endpoint)) ch.endpoint = dm.endpoint;
    if (Object.keys(ch).length) out.push({ name: dm.name, ...ch });
  }
  return out;
}

/** Implementation method value deltas (merged by name; narrative untouched). */
function implMethodsDelta(orig: any, draft: any): any[] {
  const out: any[] = [];
  for (const dm of draft.methods ?? []) {
    const om = (orig.methods ?? []).find((m: any) => m.name === dm.name);
    if (!om) continue;
    const ch: any = {};
    if ((dm.detail ?? '') !== (om.detail ?? '') && dm.detail) ch.detail = dm.detail;
    if ((dm.conformance ?? '') !== (om.conformance ?? '') && dm.conformance) ch.conformance = dm.conformance;
    if ((dm.intent ?? '') !== (om.intent ?? '')) ch.intent = dm.intent ?? '';
    if (Object.keys(ch).length) out.push({ name: dm.name, ...ch });
  }
  return out;
}

/** Type field value deltas (merged by name). */
function typeFieldsDelta(orig: any, draft: any): any[] {
  const out: any[] = [];
  for (const df of draft.fields ?? []) {
    const of = (orig.fields ?? []).find((f: any) => f.name === df.name);
    if (!of) continue;
    const ch: any = {};
    if (df.type !== of.type) ch.type = df.type;
    if ((df.description ?? '') !== (of.description ?? '')) ch.description = df.description ?? '';
    if (!!df.optional !== !!of.optional) ch.optional = !!df.optional;
    if ((df.key ?? '') !== (of.key ?? '') && df.key) ch.key = df.key; // cannot unset
    if ((df.references ?? '') !== (of.references ?? '')) ch.references = df.references ?? '';
    if (Object.keys(ch).length) out.push({ name: df.name, ...ch });
  }
  return out;
}

/** publicInterfaces value deltas (merged by component+interface). */
function piDelta(orig: any, draft: any, kind: SpecKind): any[] {
  const out: any[] = [];
  const list = draft.publicInterfaces ?? [];
  for (let i = 0; i < list.length; i++) {
    const dpi = list[i];
    const opi = (orig.publicInterfaces ?? [])[i];
    if (!opi) continue;
    const ch: any = {};
    if ((dpi.type ?? '') !== (opi.type ?? '') && dpi.type) ch.type = dpi.type;
    if ((dpi.details ?? '') !== (opi.details ?? '')) ch.details = dpi.details ?? '';
    if (kind === 'system') {
      if ((dpi.name ?? '') !== (opi.name ?? '')) ch.name = dpi.name ?? '';
      if ((dpi.audience ?? '') !== (opi.audience ?? '') && dpi.audience) ch.audience = dpi.audience;
    }
    if (Object.keys(ch).length) {
      out.push({
        ...(opi.component !== undefined ? { component: opi.component } : {}),
        ...(opi.interface !== undefined ? { interface: opi.interface } : {}),
        ...ch,
      });
    }
  }
  return out;
}

/** Subsystem lifecycle deltas — description only (phase+component+method are the
 *  merge identity, so they are never changed here). */
function lifecycleDelta(orig: any, draft: any): any[] {
  const out: any[] = [];
  const list = draft.lifecycle ?? [];
  for (let i = 0; i < list.length; i++) {
    const dl = list[i];
    const ol = (orig.lifecycle ?? [])[i];
    if (!ol) continue;
    if ((dl.description ?? '') !== (ol.description ?? '')) {
      out.push({ phase: ol.phase, component: ol.component, method: ol.method, description: dl.description ?? '' });
    }
  }
  return out;
}

function buildDelta(kind: SpecKind, orig: any, draft: any): Record<string, unknown> {
  const delta = scalarDelta(kind, orig, draft);
  if (kind === 'component' && !jeq(draft.externalLinks ?? [], orig.externalLinks ?? [])) {
    delta.externalLinks = draft.externalLinks ?? [];
  }
  if (kind === 'component' && !jeq(draft.auth ?? null, orig.auth ?? null)) {
    delta.auth = draft.auth ?? { scheme: 'none' };
  }
  if (kind === 'implementation' && !jeq(draft.technologies ?? [], orig.technologies ?? [])) {
    delta.technologies = draft.technologies ?? [];
  }
  if (kind === 'interface') {
    const md = interfaceMethodsDelta(orig, draft);
    if (md.length) delta.methods = md;
  }
  if (kind === 'implementation') {
    const md = implMethodsDelta(orig, draft);
    if (md.length) delta.methods = md;
  }
  if (kind === 'type') {
    const fd = typeFieldsDelta(orig, draft);
    if (fd.length) delta.fields = fd;
  }
  if (kind === 'subsystem' || kind === 'system') {
    const pd = piDelta(orig, draft, kind);
    if (pd.length) delta.publicInterfaces = pd;
  }
  if (kind === 'system') {
    // boundaries/globalRequirements are non-special-cased top-level arrays, so
    // the merge replaces them wholesale — send the full list on any change.
    if (!jeq(draft.boundaries ?? [], orig.boundaries ?? [])) delta.boundaries = draft.boundaries ?? [];
    if (!jeq(draft.globalRequirements ?? [], orig.globalRequirements ?? [])) delta.globalRequirements = draft.globalRequirements ?? [];
  }
  if (kind === 'subsystem') {
    const ld = lifecycleDelta(orig, draft);
    if (ld.length) delta.lifecycle = ld;
  }
  return delta;
}

// ── Endpoint editor (interface methods) ─────────────────────────────────────────

function EndpointEditor(props: { endpoint: any; onChange: (ep: any) => void; disabled?: boolean }) {
  const ep = props.endpoint ?? {};
  const t = ep.transport ?? 'HTTP';
  const set = (patch: Record<string, unknown>) => props.onChange({ ...ep, ...patch });
  const setTransport = (nt: string) => props.onChange({ transport: nt }); // reset — fields differ per transport
  return (
    <div className="row-form">
      <Field label="Transport">
        <EnumSelect value={t} onChange={setTransport} options={TRANSPORT} disabled={props.disabled} />
      </Field>
      {t === 'HTTP' && (
        <>
          <Field label="HTTP method"><EnumSelect value={ep.method} onChange={(v) => set({ method: v })} options={HTTP_METHOD} disabled={props.disabled} /></Field>
          <Field label="Path"><TextInput value={ep.path ?? ''} onChange={(v) => set({ path: v })} placeholder="/v1/checkout" disabled={props.disabled} /></Field>
        </>
      )}
      {t === 'gRPC' && (
        <>
          <Field label="Service"><TextInput value={ep.service ?? ''} onChange={(v) => set({ service: v })} disabled={props.disabled} /></Field>
          <Field label="RPC method"><TextInput value={ep.method ?? ''} onChange={(v) => set({ method: v })} disabled={props.disabled} /></Field>
        </>
      )}
      {t === 'GraphQL' && (
        <>
          <Field label="Operation"><EnumSelect value={ep.operation} onChange={(v) => set({ operation: v })} options={GRAPHQL_OP} disabled={props.disabled} /></Field>
          <Field label="Field"><TextInput value={ep.field ?? ''} onChange={(v) => set({ field: v })} disabled={props.disabled} /></Field>
        </>
      )}
      {t === 'MessageBus' && (
        <>
          <Field label="Topic"><TextInput value={ep.topic ?? ''} onChange={(v) => set({ topic: v })} disabled={props.disabled} /></Field>
          <Field label="Event"><TextInput value={ep.event ?? ''} onChange={(v) => set({ event: v })} disabled={props.disabled} /></Field>
          <Field label="Queue (optional)"><TextInput value={ep.queue ?? ''} onChange={(v) => set({ queue: v })} disabled={props.disabled} /></Field>
          <Field label="Direction"><EnumSelect value={ep.direction ?? 'subscribe'} onChange={(v) => set({ direction: v })} options={MB_DIRECTION} disabled={props.disabled} /></Field>
        </>
      )}
      {t === 'NamedPipe' && <Field label="Pipe"><TextInput value={ep.pipe ?? ''} onChange={(v) => set({ pipe: v })} disabled={props.disabled} /></Field>}
      {t === 'IPC' && <Field label="Channel"><TextInput value={ep.channel ?? ''} onChange={(v) => set({ channel: v })} disabled={props.disabled} /></Field>}
      {t === 'CLI' && <Field label="Command"><TextInput value={ep.command ?? ''} onChange={(v) => set({ command: v })} disabled={props.disabled} /></Field>}
      {t === 'Custom' && <Field label="Address"><TextInput value={ep.address ?? ''} onChange={(v) => set({ address: v })} disabled={props.disabled} /></Field>}
    </div>
  );
}

// ── The per-spec value form ─────────────────────────────────────────────────────

function SpecForm(props: {
  projectId: string;
  sel: Selected;
  spec: any;
  typeSuggestions: string[];
  profiles: AvailableProfile[];
  onSaved: () => void;
  /** When present (implementation tab), each method offers a "view flow" deep-link. */
  onViewFlow?: (method: string) => void;
  /** This spec's field → severity flags, from the validation rail (already
   *  pre-filtered to sel.id by SpecsTab — see openSpecFieldFlags). */
  fieldFlags?: FieldFlags;
  /** Bumped by the validation rail when a finding's message is clicked;
   *  scrolls to + (via fieldFlags) highlights the named field. */
  scrollRequest?: { field: string; nonce: number } | null;
}) {
  const { projectId, sel, spec, typeSuggestions } = props;
  const toast = useToast();
  const [draft, setDraft] = useState<any>(() => clone(spec));
  const formRef = useRef<HTMLDivElement>(null);
  const fieldFlags = props.fieldFlags ?? EMPTY_FIELD_FLAGS;
  const flagFor = (field: string) => fieldFlags.get(field);

  // Re-sync when a fresh load arrives (useAsync mints a new object on reload).
  useEffect(() => {
    setDraft(clone(spec));
  }, [spec]);

  // Scroll to + (via the field's own `highlight` prop) flash the field a
  // clicked finding names — only reachable when that field is on THIS spec.
  useEffect(() => {
    if (!props.scrollRequest) return;
    const el = formRef.current?.querySelector(`[data-field="${CSS.escape(props.scrollRequest.field)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scrollRequest]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(spec), [draft, spec]);

  const set = (field: string, value: unknown) => setDraft((d: any) => ({ ...d, [field]: value }));
  const setArrItem = (arr: string, index: number, patch: Record<string, unknown>) =>
    setDraft((d: any) => ({ ...d, [arr]: (d[arr] ?? []).map((it: any, i: number) => (i === index ? { ...it, ...patch } : it)) }));
  const setMethodParam = (mIdx: number, pIdx: number, patch: Record<string, unknown>) =>
    setDraft((d: any) => ({
      ...d,
      methods: d.methods.map((m: any, i: number) =>
        i === mIdx ? { ...m, params: (m.params ?? []).map((p: any, j: number) => (j === pIdx ? { ...p, ...patch } : p)) } : m),
    }));

  async function save() {
    const delta = buildDelta(sel.kind, spec, draft);
    if (Object.keys(delta).length === 0) {
      toast.ok('No value changes to save.');
      return;
    }
    await mcpCall(projectId, 'sdd_update_spec', { kind: sel.kind, id: sel.id, delta });
    toast.ok(`Saved ${sel.kind} “${sel.label}”`);
    props.onSaved();
  }

  const profGroups = useMemo(() => withCurrent(profileGroups(props.profiles), draft.profile ?? ''), [props.profiles, draft.profile]);
  const paramSuggestions = useMemo(() => [...PRIMITIVES, ...typeSuggestions], [typeSuggestions]);

  return (
    <div className="stack-lg" ref={formRef}>
      <div className="view-head">
        <div className="cell-stack">
          <div>
            <Badge tone="accent">{sel.kind}</Badge> <strong>{draft.name ?? sel.label}</strong>
          </div>
          <code className="subtle">{sel.id}</code>
        </div>
        <div className="row-actions">
          <AsyncButton variant="primary" action={save} onError={toast.bad} disabled={!dirty}>Save changes</AsyncButton>
        </div>
      </div>

      {/* ── System (L0) ── */}
      {sel.kind === 'system' && (
        <div className="panel stack-lg">
          <Field label="Vision" hint="The system's vision, mission, and core goals.">
            <textarea className="input" rows={4} value={draft.vision ?? ''} onChange={(e) => set('vision', e.target.value)} />
          </Field>
          <Field label="Boundaries" hint="In / out-of-scope statements that bound the system.">
            <TextListEditor
              items={draft.boundaries ?? []}
              onChange={(v) => set('boundaries', v)}
              getText={(it) => (typeof it === 'string' ? it : it?.name ?? '')}
              setText={(it, t) => (typeof it === 'string' ? t : { ...it, name: t })}
              placeholder="e.g. Out of scope: billing & invoicing"
              addLabel="boundary"
            />
          </Field>
          <Field label="Global requirements" hint="System-wide requirements every subsystem must honor.">
            <TextListEditor
              items={draft.globalRequirements ?? []}
              onChange={(v) => set('globalRequirements', v)}
              getText={(it) => (typeof it === 'string' ? it : it?.description ?? '')}
              setText={(it, t) => (typeof it === 'string' ? t : { ...it, description: t })}
              placeholder="e.g. All PII encrypted at rest"
              addLabel="requirement"
            />
          </Field>
          {(draft.publicInterfaces ?? []).length > 0 && (
            <div className="stack-lg">
              <span className="field-label">Gateway surface entries</span>
              {draft.publicInterfaces.map((pi: any, i: number) => (
                <div key={i} className="sub-card">
                  <code className="subtle">{pi.id ?? pi.component ?? `entry ${i + 1}`}</code>
                  <div className="row-form">
                    <Field label="Name"><TextInput value={pi.name ?? ''} onChange={(v) => setArrItem('publicInterfaces', i, { name: v })} /></Field>
                    <Field label="Type"><EnumSelect value={pi.type} onChange={(v) => setArrItem('publicInterfaces', i, { type: v })} options={PUBLIC_INTERFACE_TYPE} allowNone /></Field>
                    <Field label="Audience"><EnumSelect value={pi.audience} onChange={(v) => setArrItem('publicInterfaces', i, { audience: v })} options={AUDIENCE} allowNone /></Field>
                  </div>
                  <Field label="Details"><TextInput value={pi.details ?? ''} onChange={(v) => setArrItem('publicInterfaces', i, { details: v })} /></Field>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Subsystem (L1) ── */}
      {sel.kind === 'subsystem' && (
        <div className="panel stack-lg">
          <div className="row-form">
            <Field label="Name"><TextInput value={draft.name ?? ''} onChange={(v) => set('name', v)} /></Field>
            <Field label="Status"><EnumSelect value={draft.status} onChange={(v) => set('status', v)} options={STATUS} /></Field>
          </div>
          <Field label="Description" fieldKey="description" highlight={flagFor('description')}><textarea className="input" rows={3} value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
          <div className="row-form">
            <Field label="Profile" hint="Architectural profile (built-in or pack-provided)." fieldKey="profile" highlight={flagFor('profile')}>
              <GroupedSelect value={draft.profile ?? ''} onChange={(v) => set('profile', v)} groups={profGroups} includeNone noneLabel="(inherit)" />
            </Field>
            <Field label="Design depth"><EnumSelect value={draft.designDepth} onChange={(v) => set('designDepth', v)} options={DESIGN_DEPTH} allowNone noneLabel="(project default)" /></Field>
            <Field label="Target language"><TextInput value={draft.targetLanguage ?? ''} onChange={(v) => set('targetLanguage', v)} placeholder="(inherit system)" /></Field>
          </div>
          {(draft.publicInterfaces ?? []).length > 0 && (
            <div className={`stack-lg${flagFor('publicInterfaces') ? ` field-flag field-flag-${flagFor('publicInterfaces')}` : ''}`} data-field="publicInterfaces">
              <span className="field-label">Public interfaces</span>
              {draft.publicInterfaces.map((pi: any, i: number) => (
                <div key={i} className="sub-card">
                  <code className="subtle">{pi.component ? `${pi.component}${pi.interface ? ` · ${pi.interface}` : ''}` : `entry ${i + 1}`}</code>
                  <div className="row-form">
                    <Field label="Type"><EnumSelect value={pi.type} onChange={(v) => setArrItem('publicInterfaces', i, { type: v })} options={PUBLIC_INTERFACE_TYPE} /></Field>
                    <Field label="Details"><TextInput value={pi.details ?? ''} onChange={(v) => setArrItem('publicInterfaces', i, { details: v })} /></Field>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(draft.lifecycle ?? []).length > 0 && (
            <div className="stack-lg">
              <span className="field-label">Lifecycle entrypoints</span>
              {draft.lifecycle.map((le: any, i: number) => (
                <div key={i} className="sub-card">
                  <div className="row-form">
                    <Field label="Phase" hint="Identity — read-only."><EnumSelect value={le.phase} onChange={() => {}} options={['init', 'shutdown', 'cyclic', 'interrupt', 'scheduled']} disabled /></Field>
                    <Field label="Component · method"><code className="preview-id">{le.component}.{le.method}</code></Field>
                  </div>
                  <Field label="Description"><TextInput value={le.description ?? ''} onChange={(v) => setArrItem('lifecycle', i, { description: v })} /></Field>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Component (L2) ── */}
      {sel.kind === 'component' && (
        <div className="panel stack-lg">
          <div className="row-form">
            <Field label="Name"><TextInput value={draft.name ?? ''} onChange={(v) => set('name', v)} /></Field>
            <Field label="Status"><EnumSelect value={draft.status} onChange={(v) => set('status', v)} options={STATUS} /></Field>
          </div>
          <Field label="Description" fieldKey="description" highlight={flagFor('description')}><textarea className="input" rows={3} value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
          <div className="row-form">
            <Field label="Component type" fieldKey="componentType" highlight={flagFor('componentType')}><EnumSelect value={draft.componentType} onChange={(v) => set('componentType', v)} options={COMPONENT_TYPE} /></Field>
            {draft.componentType === 'Portal' && (
              <Field label="Portal type"><EnumSelect value={draft.portalType} onChange={(v) => set('portalType', v)} options={PORTAL_TYPE} allowNone /></Field>
            )}
            {draft.componentType === 'Store' && (
              <Field label="Durability" fieldKey="durability" highlight={flagFor('durability')}><EnumSelect value={draft.durability} onChange={(v) => set('durability', v)} options={DURABILITY} allowNone /></Field>
            )}
          </div>
          {draft.componentType === 'Portal' && (
            <Field label="Base path" hint="Prefix all this portal's endpoints mount under (the OpenAPI server url)."><TextInput value={draft.basePath ?? ''} onChange={(v) => set('basePath', v)} placeholder="/v1" /></Field>
          )}
          {draft.componentType === 'Portal' && (
            <Field label="Authentication" hint="This portal's API auth — projected into its OpenAPI securitySchemes/security. Each public portal becomes its own named OpenAPI spec.">
              <PortalAuthEditor auth={draft.auth} onChange={(v) => set('auth', v)} />
            </Field>
          )}
          <Field label="External links" hint="Opaque URLs wairon does not fetch. An 'implementation' link is the external source-of-record (a Make scenario, cloud console, GitHub file) and satisfies the source requirement — no MISSING_SOURCE_PATH.">
            <ExternalLinksEditor links={draft.externalLinks ?? []} onChange={(v) => set('externalLinks', v)} />
          </Field>
        </div>
      )}

      {/* ── Interface (L3) ── */}
      {sel.kind === 'interface' && (
        <div className="panel stack-lg">
          <div className="row-form">
            <Field label="Name"><TextInput value={draft.name ?? ''} onChange={(v) => set('name', v)} /></Field>
          </div>
          <Field label="Description" fieldKey="description" highlight={flagFor('description')}><textarea className="input" rows={3} value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
          {(draft.methods ?? []).length > 0 && (
            <div className="stack-lg">
              <span className="field-label">Methods</span>
              {draft.methods.map((m: any, i: number) => (
                <div key={m.name} className="sub-card">
                  <code className="subtle">{m.name}</code>
                  <Field label="Description"><TextInput value={m.description ?? ''} onChange={(v) => setArrItem('methods', i, { description: v })} /></Field>
                  <div className="row-form">
                    <Field label="Signature"><TextInput value={m.signature ?? ''} onChange={(v) => setArrItem('methods', i, { signature: v })} /></Field>
                    <Field label="Returns"><TextInput value={m.returns ?? ''} onChange={(v) => setArrItem('methods', i, { returns: v })} /></Field>
                    <Field label="Effect"><EnumSelect value={m.effect} onChange={(v) => setArrItem('methods', i, { effect: v })} options={METHOD_EFFECT} allowNone /></Field>
                  </div>
                  <Field label="Guarantees" hint="Builtin tokens plus any pack-declared ones.">
                    <TagInput values={m.guarantees ?? []} onChange={(v) => setArrItem('methods', i, { guarantees: v })} suggestions={BUILTIN_GUARANTEES} />
                  </Field>
                  {(m.params ?? []).length > 0 && (
                    <div className="stack-lg">
                      <span className="hint">Parameters</span>
                      {m.params.map((p: any, j: number) => (
                        <div key={p.name} className="row-form">
                          <Field label={`Param · ${p.name}`}><Combobox value={p.type} onChange={(v) => setMethodParam(i, j, { type: v })} suggestions={paramSuggestions} placeholder="type" /></Field>
                          <Field label="Description"><TextInput value={p.description ?? ''} onChange={(v) => setMethodParam(i, j, { description: v })} /></Field>
                          <Field label="Optional"><Checkbox checked={!!p.optional} onChange={(v) => setMethodParam(i, j, { optional: v })} label="" /></Field>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.endpoint !== undefined && (
                    <Field label="Endpoint">
                      <EndpointEditor endpoint={m.endpoint} onChange={(ep) => setArrItem('methods', i, { endpoint: ep })} />
                    </Field>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Implementation (L4) ── */}
      {sel.kind === 'implementation' && (
        <div className="panel stack-lg">
          <div className="row-form">
            <Field label="Name"><TextInput value={draft.name ?? ''} onChange={(v) => set('name', v)} /></Field>
            <Field label="Status"><EnumSelect value={draft.status} onChange={(v) => set('status', v)} options={STATUS} /></Field>
          </div>
          <Field label="Description" fieldKey="description" highlight={flagFor('description')}><textarea className="input" rows={3} value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
          <div className="row-form">
            <Field label="Narrative detail (default)"><EnumSelect value={draft.detail} onChange={(v) => set('detail', v)} options={NARRATIVE_DETAIL} allowNone noneLabel="(stereotype default)" /></Field>
            <Field label="Conformance (default)"><EnumSelect value={draft.conformance} onChange={(v) => set('conformance', v)} options={CONFORMANCE} allowNone noneLabel="(stereotype default)" /></Field>
          </div>
          <Field label="Technologies" hint="External technologies this implementation binds to.">
            <TagInput values={draft.technologies ?? []} onChange={(v) => set('technologies', v)} placeholder="e.g. mysql, sendgrid…" />
          </Field>
          {(draft.methods ?? []).length > 0 && (
            <div className="stack-lg">
              <span className="field-label">Methods</span>
              {draft.methods.map((m: any, i: number) => (
                <div key={m.name} className="sub-card">
                  <div className="method-head">
                    <code className="subtle">{m.name}</code>
                    {/* Only narrated methods have a flow to show — an intent-only
                        method has no narrative (mirrors the canvas hiding flow/steps). */}
                    {props.onViewFlow && (m.narrative?.length ?? 0) > 0 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => props.onViewFlow!(m.name)}
                        title="Open this method's narrative flow in the canvas"
                      >
                        flow ↗
                      </button>
                    )}
                  </div>
                  <div className="row-form">
                    <Field label="Detail"><EnumSelect value={m.detail} onChange={(v) => setArrItem('methods', i, { detail: v })} options={NARRATIVE_DETAIL} allowNone noneLabel="(spec default)" /></Field>
                    <Field label="Conformance"><EnumSelect value={m.conformance} onChange={(v) => setArrItem('methods', i, { conformance: v })} options={CONFORMANCE} allowNone noneLabel="(spec default)" /></Field>
                  </div>
                  <Field label="Intent" hint="Behavioral prose — the narrative substitute at detail: intent.">
                    <textarea className="input" rows={2} value={m.intent ?? ''} onChange={(e) => setArrItem('methods', i, { intent: e.target.value })} />
                  </Field>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Type (entity / value-object) ── */}
      {sel.kind === 'type' && (
        <div className="panel stack-lg">
          <div className="row-form">
            <Field label="Name"><TextInput value={draft.name ?? ''} onChange={(v) => set('name', v)} /></Field>
            <Field label="Kind"><EnumSelect value={draft.kind} onChange={(v) => set('kind', v)} options={TYPE_KIND} /></Field>
          </div>
          <Field label="Description" fieldKey="description" highlight={flagFor('description')}><textarea className="input" rows={3} value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
          {(draft.fields ?? []).length > 0 && (
            <div className="stack-lg">
              <span className="field-label">Fields</span>
              {draft.fields.map((f: any, i: number) => (
                <div key={f.name} className="sub-card">
                  <code className="subtle">{f.name}</code>
                  <div className="row-form">
                    <Field label="Type"><Combobox value={f.type} onChange={(v) => setArrItem('fields', i, { type: v })} suggestions={paramSuggestions} /></Field>
                    <Field label="Key"><EnumSelect value={f.key} onChange={(v) => setArrItem('fields', i, { key: v })} options={TYPE_FIELD_KEY} allowNone /></Field>
                    <Field label="Optional"><Checkbox checked={!!f.optional} onChange={(v) => setArrItem('fields', i, { optional: v })} label="" /></Field>
                  </div>
                  <div className="row-form">
                    <Field label="Description"><TextInput value={f.description ?? ''} onChange={(v) => setArrItem('fields', i, { description: v })} /></Field>
                    <Field label="References (FK)"><Combobox value={f.references} onChange={(v) => setArrItem('fields', i, { references: v })} suggestions={typeSuggestions} placeholder="e.g. billing.Invoice.id" /></Field>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Editor host (loads the selected spec) ───────────────────────────────────────

function SpecEditor(props: {
  projectId: string;
  sel: Selected;
  typeSuggestions: string[];
  profiles: AvailableProfile[];
  onGraphChange: () => void;
  onViewFlow?: (method: string) => void;
  fieldFlags?: FieldFlags;
  scrollRequest?: { field: string; nonce: number } | null;
}) {
  const { projectId, sel } = props;
  const spec = useAsync<any>(() => mcpCall(projectId, 'sdd_get_spec', { kind: sel.kind, id: sel.id }), [projectId, sel.kind, sel.id]);
  return (
    <AsyncView state={spec}>
      {(data) => (
        <SpecForm
          key={`${sel.kind}:${sel.id}`}
          projectId={projectId}
          sel={sel}
          spec={data}
          typeSuggestions={props.typeSuggestions}
          profiles={props.profiles}
          onViewFlow={props.onViewFlow}
          fieldFlags={props.fieldFlags}
          scrollRequest={props.scrollRequest}
          onSaved={() => {
            spec.reload();
            props.onGraphChange();
          }}
        />
      )}
    </AsyncView>
  );
}

// ── Left picker ─────────────────────────────────────────────────────────────────

/** The left tree lists COMPONENTS only, nesting each owned member block under its
 *  owner (a Repository over its Store/Registry/Index). Interfaces and implementations
 *  are NOT tree rows — they are tabs of the selected component (ComponentUnitEditor).
 *  Selecting a component opens its primary interface (interface-first); the active
 *  component (resolved from an interface/impl selection) is what highlights. */
function Picker(props: {
  graph: Graph;
  activeComponentId: string | null;
  selected: Selected | null;
  onSelect: (s: Selected) => void;
}) {
  const { graph, activeComponentId, selected, onSelect } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const nodes = graph.nodes ?? [];
  const sys = nodes.find((n) => n.kind === 'project');
  const subs = nodes.filter((n) => n.kind === 'subsystem').sort(byLabel);
  const types = nodes.filter((n) => n.kind === 'type').sort(byLabel);
  const componentNodes = nodes.filter((n) => n.kind === 'component');
  const compIds = new Set(componentNodes.map((n) => n.id));

  // owns edges between two components drive the nesting (Repository ▸ members).
  const ownedBy = new Map<string, string>();
  const childrenOf = new Map<string, GraphNode[]>();
  for (const e of graph.edges ?? []) {
    if (e.edgeKind !== 'owns' || !compIds.has(e.from) || !compIds.has(e.to)) continue;
    ownedBy.set(e.to, e.from);
    const child = componentNodes.find((n) => n.id === e.to);
    if (child) childrenOf.set(e.from, [...(childrenOf.get(e.from) ?? []), child]);
  }
  const topComps = (subId: string) =>
    componentNodes.filter((n) => n.parentId === subId && !ownedBy.has(n.id)).sort(byLabel);
  const owned = (compId: string) => (childrenOf.get(compId) ?? []).slice().sort(byLabel);

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Selecting a component opens its Component tab (identity/type/description);
  // its Interface and Implementation are one tab-click away.
  const openComponent = (c: GraphNode) => onSelect({ kind: 'component', id: c.id, label: c.label });

  const SimpleRow = (p: { kind: SpecKind; id: string; label: string; depth: number; hasKids?: boolean }) => (
    <div className="tree-row" style={{ paddingLeft: 6 + p.depth * 14 }}>
      {p.hasKids ? (
        <button className="tree-caret" aria-label="expand" onClick={() => toggle(p.id)}>{collapsed.has(p.id) ? '▸' : '▾'}</button>
      ) : (
        <span className="tree-caret-spacer" />
      )}
      <button
        className={`tree-label ${selected?.kind === p.kind && selected?.id === p.id ? 'sel' : ''}`}
        onClick={() => onSelect({ kind: p.kind, id: p.id, label: p.label })}
        title={p.id}
      >
        <span className={`tree-kind k-${p.kind}`}>{p.kind[0].toUpperCase()}</span>
        <span className="tree-name">{p.label}</span>
      </button>
    </div>
  );

  const renderComponent = (c: GraphNode, depth: number): JSX.Element => {
    const kids = owned(c.id);
    const expanded = !collapsed.has(c.id);
    return (
      <div key={c.id}>
        <div className="tree-row" style={{ paddingLeft: 6 + depth * 14 }}>
          {kids.length ? (
            <button className="tree-caret" aria-label="expand" onClick={() => toggle(c.id)}>{expanded ? '▾' : '▸'}</button>
          ) : (
            <span className="tree-caret-spacer" />
          )}
          <button
            className={`tree-label ${activeComponentId === c.id ? 'sel' : ''}`}
            onClick={() => openComponent(c)}
            title={c.id}
          >
            <span className="tree-kind k-component">C</span>
            <span className="tree-name">{c.label}</span>
          </button>
        </div>
        {expanded && kids.map((k) => renderComponent(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="spec-picker">
      <div className="spec-tree">
        {sys && <SimpleRow kind="system" id={sys.id} label={sys.label} depth={0} />}
        {subs.map((s) => {
          const comps = topComps(s.id);
          return (
            <div key={s.id}>
              <SimpleRow kind="subsystem" id={s.id} label={s.label} depth={0} hasKids={comps.length > 0} />
              {!collapsed.has(s.id) && comps.map((c) => renderComponent(c, 1))}
            </div>
          );
        })}
        {types.length > 0 && (
          <div className="tree-section">
            <span className="tree-section-head">Types</span>
            {types.map((t) => <SimpleRow key={t.id} kind="type" id={t.id} label={t.label} depth={0} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/** A component's Component/Interface/Implementation specs as tabs — the selected
 *  tab is URL-tracked (onSelectSpec), so switching tabs is shareable and the
 *  canvas can deep-link to any of them. Multiple interfaces/impls each get a tab;
 *  a component with no implementation shows a disabled "Implementation" tab. */
function ComponentUnitEditor(props: {
  projectId: string;
  componentId: string;
  selection: Selected;
  nodes: GraphNode[];
  typeSuggestions: string[];
  profiles: AvailableProfile[];
  onSelectSpec: (sel: { kind: string; id: string }) => void;
  onGraphChange: () => void;
  fieldFlags?: FieldFlags;
  scrollRequest?: { field: string; nonce: number } | null;
}) {
  const { componentId, selection, nodes } = props;
  const navigate = useNavigate();
  const compNode = nodes.find((n) => n.id === componentId);
  // "Open in canvas" opens the component's PARENT (subsystem) view and focuses the
  // component — a leaf (Specialist/Store/Actor/…) has no meaningful "inside" to drill
  // into. Subsystem route = its id with '::' → '/' segments; the component to focus
  // (and, for a method, the narrative flow) rides in the URL hash. No unit prefix.
  const parentRoute = compNode?.parentId ? compNode.parentId.split('::').map(encodeURIComponent).join('/') : '';
  const canvasBase = `/canvas/${encodeURIComponent(props.projectId)}${parentRoute ? '/' + parentRoute : ''}`;
  const interfaces = nodes.filter((n) => n.kind === 'interface' && n.parentId === componentId).sort(byLabel);
  const implementations = nodes.filter((n) => n.kind === 'implementation' && n.parentId === componentId).sort(byLabel);

  type UnitTab = { key: string; label: string; sel?: { kind: SpecKind; id: string }; disabled?: boolean };
  const tabs: UnitTab[] = [
    { key: 'component', label: 'Component', sel: { kind: 'component', id: componentId } },
    ...interfaces.map((i) => ({ key: `i:${i.id}`, label: interfaces.length > 1 ? i.label : 'Interface', sel: { kind: 'interface' as SpecKind, id: i.id } })),
    ...(implementations.length
      ? implementations.map((m) => ({ key: `m:${m.id}`, label: implementations.length > 1 ? m.label : 'Implementation', sel: { kind: 'implementation' as SpecKind, id: m.id } }))
      : [{ key: 'no-impl', label: 'Implementation', disabled: true }]),
  ];

  const activeKey =
    selection.kind === 'interface' ? `i:${selection.id}`
    : selection.kind === 'implementation' ? `m:${selection.id}`
    : 'component';
  const activeDisabled = tabs.find((t) => t.key === activeKey)?.disabled;

  return (
    <div className="stack-lg">
      <div className="unit-head">
        <Badge tone="accent">component</Badge> <strong>{compNode?.label ?? componentId}</strong>
        <code className="subtle">{componentId}</code>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => navigate(`${canvasBase}#focus=${componentId}`)}
          title="View this component in the canvas (in its subsystem)"
        >
          Open in canvas ↗
        </button>
      </div>
      <div className="tabstrip" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === activeKey}
            className={`tab ${t.key === activeKey ? 'tab-active' : ''}`}
            disabled={t.disabled}
            title={t.disabled ? 'No implementation defined yet' : undefined}
            onClick={() => t.sel && props.onSelectSpec(t.sel)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {activeDisabled ? (
        <EmptyState>No implementation is defined for this component yet.</EmptyState>
      ) : (
        <SpecEditor
          key={`${selection.kind}:${selection.id}`}
          projectId={props.projectId}
          sel={selection}
          typeSuggestions={props.typeSuggestions}
          profiles={props.profiles}
          onViewFlow={(method) => navigate(`${canvasBase}#flow=${componentId}~${method}`)}
          onGraphChange={props.onGraphChange}
          fieldFlags={props.fieldFlags}
          scrollRequest={props.scrollRequest}
        />
      )}
    </div>
  );
}

// ── Project config (projectType + lock banner) — degrades if the route is absent ─

function ProjectConfigPanel(props: { projectId: string; config: Async<ProjectConfigResp | null>; profiles: AvailableProfile[] }) {
  const toast = useToast();
  const cfg = props.config.data;
  const [projectType, setProjectType] = useState(cfg?.projectType ?? 'backend');
  useEffect(() => setProjectType(cfg?.projectType ?? 'backend'), [cfg?.projectType]);

  if (!cfg) return null; // route not deployed / not readable — hide, keep the rest working

  const locked = !!cfg.locked;

  // profileGroups() itself stays source-only (it's shared with the subsystem
  // profile picker, where "installed" is meaningless) — the installed/adoptable
  // distinction is layered on top here, for this picker only: adoptable options
  // (server-global pack profiles not yet registered in this project) get a
  // label suffix so the choice is visible before you make it.
  const adoptableIds = new Set(props.profiles.filter((p) => p.installed === false).map((p) => p.id));
  const labeledGroups = [
    ...profileGroups(props.profiles),
    { label: 'Project kinds', options: PROJECT_KINDS.map((k) => ({ value: k, label: k })) },
  ].map((g) => ({
    ...g,
    options: g.options.map((o) => (adoptableIds.has(o.value) ? { ...o, label: `${o.label} — adopts pack` } : o)),
  }));
  const groups = withCurrent(labeledGroups, projectType);

  const selectedProfile = props.profiles.find((p) => p.id === projectType);
  const typeHint = selectedProfile?.installed === false
    ? `Not yet installed in this project — saving will adopt the “${selectedProfile.source}” pack so this profile applies.`
    : 'Configures targeted rules/templates for the whole project.';

  async function save() {
    const resp = await post<ProjectConfigResp>('/web/projects/config', { projectId: props.projectId, projectType });
    toast.ok(resp.adoptedPackName
      ? `Project type saved — adopted pack “${resp.adoptedPackName}” so this profile applies.`
      : 'Project type saved');
    props.config.reload();
  }

  return (
    <div className="panel stack-lg">
      {locked && (
        <div className="lock-banner">
          This project is locked — saving a spec change will invalidate the lock (a re-lock is required before promote).
        </div>
      )}
      {cfg.profileResolvable === false && (
        <div className="lock-banner">
          The recorded project type “{cfg.projectType}” doesn't resolve to a loaded profile, so its rules aren't being applied. Pick a profile from the list below to fix this.
        </div>
      )}
      <div className="row-form">
        <Field label="Project type" hint={typeHint}>
          <GroupedSelect value={projectType} onChange={setProjectType} groups={groups} />
        </Field>
        <div className="row-form-action">
          <AsyncButton variant="primary" action={save} onError={toast.bad} disabled={projectType === (cfg.projectType ?? 'backend')}>Save type</AsyncButton>
        </div>
      </div>
      {(!!cfg.unappliedProfileIds?.length || !!cfg.overridingSubsystemIds?.length) && (
        <div className="stack-sm">
          {!!cfg.unappliedProfileIds?.length && (
            <span className="hint">
              Also recorded but not applied at the project level (these govern individual subsystems instead): {cfg.unappliedProfileIds.join(', ')}.
            </span>
          )}
          {!!cfg.overridingSubsystemIds?.length && (
            <span className="hint">
              {cfg.overridingSubsystemIds.length} subsystem{cfg.overridingSubsystemIds.length === 1 ? ' declares its' : 's declare their'} own profile and {cfg.overridingSubsystemIds.length === 1 ? "isn't" : "aren't"} governed by the project type: {cfg.overridingSubsystemIds.join(', ')}.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tab entry ────────────────────────────────────────────────────────────────────

export function SpecsTab({
  projectId,
  selection,
  onSelectSpec,
}: {
  projectId: string;
  /** The open spec, from the URL path (ProjectOps owns the routing). */
  selection: { kind: string; id: string } | null;
  /** Push a new selection into the URL; null clears it. */
  onSelectSpec: (sel: { kind: string; id: string } | null) => void;
}) {
  const enc = encodeURIComponent(projectId);
  // Tree-wide validation lives at the tab level so results persist across spec
  // selection and render in the right rail (not inline, pushing the form down).
  const [validation, setValidation] = useState<{ errors: any[]; warnings: any[] } | null>(null);

  // The picker tree stays live on the project channel (a spec write elsewhere
  // refetches it); the selected spec is loaded WITHOUT a channel so an in-flight
  // edit is never clobbered — it refetches explicitly after its own save.
  // level=4 so the graph carries implementation nodes (and the component→member
  // owns edges) the tree/tab editor needs.
  const graph = useAsync<Graph>(() => get(`/web/graph?tier=project&projectId=${enc}&level=4`), [projectId], [`project:${projectId}`]);
  // Degrade gracefully when the /web/projects/config route is absent (404 — not
  // yet deployed) or unreadable: null hides the projectType control + lock banner
  // while every spec editor keeps working.
  const config = useAsync<ProjectConfigResp | null>(
    () => get<ProjectConfigResp>(`/web/projects/config?projectId=${enc}`).catch(() => null),
    [projectId],
  );
  // Project-scoped catalog (not the instance-wide /web/admin/profiles): it can
  // see packs registered in THIS project and marks each entry `installed`, so
  // the project-type picker can tell "ready to use" from "adopts a pack".
  const profiles = useAsync<AvailableProfile[]>(
    () => get(`/web/projects/profiles?projectId=${enc}`)
      .then((d) => asList<AvailableProfile>(d, 'profiles'))
      .catch(() => BUILTIN_PROFILES.map((id) => ({ id, source: 'builtin', installed: true } as AvailableProfile))),
    [projectId],
  );

  const typeSuggestions = useMemo(
    () => (graph.data?.nodes ?? []).filter((n) => n.kind === 'type').map((n) => n.id),
    [graph.data],
  );

  // The URL carries (kind, id); recover the display label from the graph (a
  // canvas deep-link or a shared URL has no label). Implementations aren't in
  // the graph, so they fall back to the id.
  const selected: Selected | null = useMemo(() => {
    if (!selection) return null;
    const node = (graph.data?.nodes ?? []).find((n) => n.id === selection.id);
    return { kind: selection.kind as SpecKind, id: selection.id, label: node?.label ?? selection.id };
  }, [selection, graph.data]);

  // The component a component/interface/implementation selection belongs to —
  // drives the tabbed editor and which tree row highlights.
  const activeComponentId = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'component') return selection.id;
    if (selection.kind === 'interface' || selection.kind === 'implementation') {
      return (graph.data?.nodes ?? []).find((n) => n.id === selection.id)?.parentId ?? null;
    }
    return null;
  }, [selection, graph.data]);

  // Validation rail scope: a component/interface/implementation selection
  // scopes to the WHOLE unit (the component + its interface(s) + its
  // implementation(s) — the same set ComponentUnitEditor tabs between);
  // a subsystem/type/system selection scopes to just that one id. Null
  // (nothing selected) means "show everything", unchanged from before.
  const scope: RailScope | null = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'component' || selected.kind === 'interface' || selected.kind === 'implementation') {
      // Normally activeComponentId resolves (it's derived from the same
      // selection); if a stale/broken deep-link ever leaves it null, still
      // scope to at least the selected id itself rather than showing nothing.
      const ids = new Set<string>([selected.id]);
      if (activeComponentId) {
        ids.add(activeComponentId);
        for (const n of graph.data?.nodes ?? []) {
          if ((n.kind === 'interface' || n.kind === 'implementation') && n.parentId === activeComponentId) ids.add(n.id);
        }
      }
      return { ids, noun: 'component' };
    }
    return { ids: new Set([selected.id]), noun: selected.kind };
  }, [selected, activeComponentId, graph.data]);

  // The rail's show-all escape hatch — reset to scoped whenever the focused
  // unit changes, so a fresh selection never silently inherits a stale
  // "show everything" choice left over from browsing a different spec.
  const [showAll, setShowAll] = useState(false);
  const scopeKey = scope ? [...scope.ids].sort().join('|') : null;
  useEffect(() => {
    setShowAll(false);
  }, [scopeKey]);

  // Bumped (via requestScroll) when a finding's message is clicked in the
  // rail; SpecForm scrolls to + highlights the named field when it matches
  // the spec it currently has open.
  const [scrollRequest, setScrollRequest] = useState<{ field: string; nonce: number } | null>(null);
  const requestScroll = (field: string) => setScrollRequest((r) => ({ field, nonce: (r?.nonce ?? 0) + 1 }));

  // Field-level flags for whatever spec is CURRENTLY open — pre-filtered to
  // its exact id (not the broader scope group) because CODE_FIELD_MAP names
  // a field that only actually renders on that one spec's own panel.
  const openSpecFieldFlags: FieldFlags = useMemo(() => {
    const map: FieldFlags = new Map();
    if (!validation || !selected) return map;
    for (const i of validation.errors) {
      if (i.specId !== selected.id) continue;
      const field = CODE_FIELD_MAP[i.code];
      if (field) map.set(field, 'error');
    }
    for (const i of validation.warnings) {
      if (i.specId !== selected.id) continue;
      const field = CODE_FIELD_MAP[i.code];
      if (field && map.get(field) !== 'error') map.set(field, 'warning');
    }
    return map;
  }, [validation, selected]);

  async function runValidate() {
    const res = await mcpCall<{ errors?: any[]; warnings?: any[] }>(projectId, 'sdd_validate_tree', {});
    setValidation({ errors: res.errors ?? [], warnings: res.warnings ?? [] });
  }

  return (
    <div className="stack-lg">
      <ProjectConfigPanel projectId={projectId} config={config} profiles={profiles.data ?? []} />
      <AsyncView state={graph}>
        {(g) => (
          <div className="spec-layout">
            <Picker
              graph={g}
              activeComponentId={activeComponentId}
              selected={selected}
              onSelect={(s) => onSelectSpec({ kind: s.kind, id: s.id })}
            />
            <div className="spec-detail">
              {selected ? (
                ['component', 'interface', 'implementation'].includes(selected.kind) && activeComponentId ? (
                  <ComponentUnitEditor
                    projectId={projectId}
                    componentId={activeComponentId}
                    selection={selected}
                    nodes={g.nodes ?? []}
                    typeSuggestions={typeSuggestions}
                    profiles={profiles.data ?? []}
                    onSelectSpec={onSelectSpec}
                    onGraphChange={() => {
                      graph.reload();
                      setValidation(null);
                    }}
                    fieldFlags={openSpecFieldFlags}
                    scrollRequest={scrollRequest}
                  />
                ) : (
                  <SpecEditor
                    projectId={projectId}
                    sel={selected}
                    typeSuggestions={typeSuggestions}
                    profiles={profiles.data ?? []}
                    onGraphChange={() => {
                      graph.reload();
                      // A spec write can change what validates — drop stale results.
                      setValidation(null);
                    }}
                    fieldFlags={openSpecFieldFlags}
                    scrollRequest={scrollRequest}
                  />
                )
              ) : (
                <EmptyState>
                  {profiles.loading ? <Spinner /> : 'Select a component on the left to view and edit its specs.'}
                </EmptyState>
              )}
            </div>
            <ValidationRail
              validation={validation}
              onValidate={runValidate}
              nodes={g.nodes ?? []}
              onSelectSpec={onSelectSpec}
              scope={scope}
              showAll={showAll}
              onToggleShowAll={() => setShowAll((s) => !s)}
              openSpecId={selected?.id ?? null}
              onRequestScroll={requestScroll}
            />
          </div>
        )}
      </AsyncView>
    </div>
  );
}
