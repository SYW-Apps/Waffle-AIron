import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, rewriteReferences, TYPE_EXPRESSION_PATHS } from '../../src/core/specs.js';
import { projectFamily } from '../../src/core/index.js';
import {
  ComponentSpecSchema,
  ImplementationSpecSchema,
  InterfaceSpecSchema,
  SubsystemSpecSchema,
  SystemSpecSchema,
  TypeSpecSchema,
} from '../../src/models/index.js';
import type { WritableSpecKind } from '../../src/core/specs.js';
import { isolateGlobals, projectYaml, specs, tempDir } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// The reference-position table, enumerated against the spec schemas.
//
// Every string a spec schema holds is classified here exactly once: a
// REFERENCE position (where a spec names another spec, or a type, and a family
// migration must respell it), or a NOT_A_REFERENCE field with the reason it is
// not one. A field added to a schema and classified nowhere fails the first
// test, so a future position cannot be missed silently. Then each reference
// position is proven end to end on a real tree: the respelling writer (the one
// every family migration writes through) rewrites a marker planted there, and
// the scan (the one every planner reads) records it. This is the test the
// trial's misses — a type method's signature and returns, which rename-alias
// left behind — would have failed.
// ---------------------------------------------------------------------------

type Kind = 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type';

interface Position {
  kind: Kind;
  /** The schema leaf path: dotted field names, list fields walked element-wise. */
  path: string;
  /** The position name the scan records and the writer's edits address. */
  position: string;
  /** The marker planted in the fixture (unique), and what a respelling turns it into. */
  marker: string;
  /** The scan records it (a `::` reference); false for the L0, which the scan does not bind, and plain-id positions. */
  scanned: boolean;
}

/**
 * THE reference positions. A method name is not here: it carries no project
 * qualifier (a family migration never respells one; sdd_rename_method does,
 * through rewriteSpecRefs). Order matters for the end-to-end test only in that
 * the positions which decide where a spec loads (a component's or a type's
 * subsystem, an interface's component, an implementation's contract) come last.
 */
const REFERENCE_POSITIONS: Position[] = [
  // The L0 export table: re-exports and what they name. `subsystem` is the legacy `from`.
  { kind: 'system', path: 'publicInterfaces.from', position: 'publicInterfaces', marker: 'zz-sys-from', scanned: false },
  { kind: 'system', path: 'publicInterfaces.subsystem', position: 'publicInterfaces', marker: 'zz-sys-legacy', scanned: false },
  { kind: 'system', path: 'publicInterfaces.component', position: 'publicInterfaces', marker: 'zz-sys-comp', scanned: false },
  { kind: 'system', path: 'publicInterfaces.interface', position: 'publicInterfaces', marker: 'zz-sys-intf', scanned: false },
  { kind: 'system', path: 'publicInterfaces.typeDef', position: 'publicInterfaces', marker: 'zz-sys-type', scanned: false },
  // A subsystem's published interfaces (each a spec id), its lifecycle, its trusted links.
  { kind: 'subsystem', path: 'publicInterfaces.component', position: 'publicInterfaces', marker: 'zz-sub-comp', scanned: false },
  { kind: 'subsystem', path: 'publicInterfaces.interface', position: 'publicInterfaces', marker: 'zz-sub-intf', scanned: false },
  { kind: 'subsystem', path: 'publicInterfaces.from', position: 'publicInterfaces', marker: 'zz-sub-from', scanned: false },
  { kind: 'subsystem', path: 'publicInterfaces.typeDef', position: 'publicInterfaces', marker: 'zz-sub-type', scanned: false },
  { kind: 'subsystem', path: 'publicInterfaces.consumers', position: 'publicInterfaces', marker: 'zz-sub-cons', scanned: false },
  { kind: 'subsystem', path: 'lifecycle.component', position: 'lifecycle', marker: 'ext::zz-life', scanned: true },
  { kind: 'subsystem', path: 'trustedLinks.subsystem', position: 'trustedLinks', marker: 'zz-trust', scanned: false },
  // A component's collaborators.
  { kind: 'component', path: 'owns', position: 'owns', marker: 'ext::zz-own', scanned: true },
  { kind: 'component', path: 'dependsOn', position: 'dependsOn', marker: 'ext::zz-dep', scanned: true },
  { kind: 'component', path: 'dispatch.component', position: 'dispatch', marker: 'ext::zz-disp', scanned: true },
  // Every type-expression position (TYPE_EXPRESSION_PATHS), each its own marker.
  { kind: 'interface', path: 'methods.signature', position: 'type', marker: 'ext::zz-isig', scanned: true },
  { kind: 'interface', path: 'methods.returns', position: 'type', marker: 'ext::zz-iret', scanned: true },
  { kind: 'interface', path: 'methods.params.type', position: 'type', marker: 'ext::zz-ipar', scanned: true },
  { kind: 'interface', path: 'methods.signatureFrom', position: 'type', marker: 'ext::zz-isf', scanned: true },
  { kind: 'type', path: 'fields.type', position: 'type', marker: 'ext::zz-tfield', scanned: true },
  { kind: 'type', path: 'methods.signature', position: 'type', marker: 'ext::zz-tmsig', scanned: true },
  { kind: 'type', path: 'methods.returns', position: 'type', marker: 'ext::zz-tmret', scanned: true },
  { kind: 'type', path: 'methods.params.type', position: 'type', marker: 'ext::zz-tmpar', scanned: true },
  { kind: 'type', path: 'params.type', position: 'type', marker: 'ext::zz-sigpar', scanned: true },
  { kind: 'type', path: 'returns', position: 'type', marker: 'ext::zz-sigret', scanned: true },
  // An implementation's narrative and declared calls.
  { kind: 'implementation', path: 'methods.narrative.targetComponent', position: 'narrative', marker: 'ext::zz-narr', scanned: true },
  { kind: 'implementation', path: 'methods.narrative.auth.from', position: 'auth', marker: 'component:ext::zz-auth', scanned: true },
  { kind: 'implementation', path: 'methods.narrative.assertsInvariants', position: 'type', marker: 'ext::zz-inv.balanced', scanned: true },
  { kind: 'implementation', path: 'methods.calls', position: 'calls', marker: 'ext::zz-call.run', scanned: true },
  // Last: the positions that decide where a spec loads.
  { kind: 'type', path: 'group', position: 'group', marker: 'zz-grp', scanned: false },
  { kind: 'component', path: 'subsystem', position: 'subsystem', marker: 'zz-sub-c', scanned: false },
  { kind: 'type', path: 'subsystem', position: 'subsystem', marker: 'zz-sub-t', scanned: false },
  { kind: 'interface', path: 'component', position: 'contract', marker: 'zz-c', scanned: false },
  { kind: 'implementation', path: 'contract', position: 'contract', marker: 'izz-c', scanned: false },
];

/** Every other string a spec schema holds, with the reason it is not a reference a migration respells. */
const NOT_A_REFERENCE: Record<string, string> = {
  // Identity, prose, stamps and paths — on every kind that has them.
  '*.id': 'the spec\'s own id', '**.name': 'a display name, or the name of what it sits on (a method, a field, a parameter)',
  '**.description': 'prose', '*.createdAt': 'a stamp', '*.updatedAt': 'a stamp',
  '*.previousIds': 'a rename trace: names keys that no longer exist, carried verbatim (see the reference-field table)',
  '*.lint.allow.code': 'a finding code', '*.lint.allow.reason': 'prose',
  '*.lint.allow.at': 'a finding site, rekeyed by identity renames (rekeyLintAllows); a boundary move leaves a site as the finding names it',
  '*.lint.allow.covers': 'finding units, rekeyed by identity renames (rekeyLintAllows)',
  '*.targetLanguage': 'a language name', '**.sourcePath': 'a code path', '**.symbol': 'a code-level name',
  'system.schemaVersion': 'a version', 'system.vision': 'prose', 'system.boundaries': 'prose', 'system.boundaries.name': 'prose',
  'system.boundaries.description': 'prose', 'system.globalRequirements': 'prose', 'system.globalRequirements.description': 'prose',
  'system.publicInterfaces.id': 'the legacy public name (read as `as`): a name this project gives, not a reference',
  'system.publicInterfaces.name': 'a display name', 'system.publicInterfaces.as': 'the public name this project gives',
  'system.publicInterfaces.type': 'a transport kind', 'system.publicInterfaces.details': 'prose', 'system.publicInterfaces.audience': 'an audience',
  'system.publicInterfaces.authPolicy': 'prose', 'system.publicInterfaces.version': 'a version', 'system.publicInterfaces.stability': 'a stability',
  'system.databases.id': 'a database id of the L0 itself', 'system.databases.name': 'a display name', 'system.databases.engine': 'a technology',
  'system.databases.description': 'prose', 'system.databases.tables': 'table names',
  'subsystem.parentSystem': 'the L0 name, restated by promote and internalize themselves',
  'subsystem.publicInterfaces.details': 'prose', 'subsystem.publicInterfaces.as': 'the public name this subsystem gives',
  'subsystem.lifecycle.method': 'a method name (no project qualifier; sdd_rename_method)', 'subsystem.lifecycle.description': 'prose',
  'subsystem.profile': 'a profile name', 'subsystem.projectPath': 'a deprecated mount path (doctor --fix moves it to members)',
  'subsystem.trustedLinks.reason': 'prose',
  'component.basePath': 'a URL path', 'component.auth.name': 'a header or parameter name', 'component.auth.bearerFormat': 'a token format',
  'component.auth.authorizationUrl': 'a URL', 'component.auth.tokenUrl': 'a URL', 'component.auth.refreshUrl': 'a URL',
  'component.auth.scopes.name': 'an OAuth scope', 'component.auth.scopes.description': 'prose', 'component.auth.openIdConnectUrl': 'a URL',
  'component.auth.description': 'prose', 'component.auth.example': 'an example value',
  'component.dispatch.capability': 'a capability key of this portal', 'component.dispatch.method': 'a method name (sdd_rename_method)',
  'component.dispatch.description': 'prose',
  'component.abi': 'an ABI name (c, wasm)', 'component.invokedBy.caller': 'prose',
  'interface.implements': 'an alias::name extension point the reachability implements rules bind (not yet a scanned position)',
  'implementation.router': 'a code symbol (linkage)',
  'component.emits.topic': 'a bus topic', 'component.emits.event': 'an event name', 'component.emits.description': 'prose',
  'component.subscribesTo.topic': 'a bus topic', 'component.subscribesTo.event': 'an event name', 'component.subscribesTo.description': 'prose',
  'component.patterns.id': 'a pack pattern id, not a spec', 'component.patterns.version': 'a version', 'component.variant': 'a variant name',
  'component.externalLinks.url': 'a URL wairon never resolves', 'component.externalLinks.label': 'prose',
  'interface.methods.params.name': 'a parameter name', 'interface.methods.params.description': 'prose', 'interface.methods.params.previousNames': 'a parameter rename trace, carried verbatim',
  'interface.methods.endpoint.path': 'a wire path', 'interface.methods.endpoint.service': 'a wire service name', 'interface.methods.endpoint.method': 'a wire method',
  'interface.methods.endpoint.field': 'a wire field', 'interface.methods.endpoint.topic': 'a bus topic', 'interface.methods.endpoint.event': 'an event name',
  'interface.methods.endpoint.queue': 'a queue name', 'interface.methods.endpoint.pipe': 'a pipe name', 'interface.methods.endpoint.channel': 'a channel name',
  'interface.methods.endpoint.command': 'a CLI command', 'interface.methods.endpoint.address': 'an address',
  'interface.methods.guarantees': 'guarantee tokens', 'interface.methods.invokedBy.caller': 'prose', 'interface.methods.findings.code': 'a finding code',
  'interface.methods.findings.summary': 'prose', 'interface.methods.previousNames': 'a rename trace, carried verbatim',
  'implementation.simPath': 'a code path', 'implementation.technologies': 'a technology', 'implementation.technologies.name': 'a technology',
  'implementation.technologies.matches': 'match tokens', 'implementation.injectedParams': 'parameter names',
  'implementation.methods.narrative.label': 'a step label', 'implementation.methods.narrative.targetMethod': 'a method name (sdd_rename_method)',
  'implementation.methods.narrative.capability': 'a capability key of the target portal', 'implementation.methods.narrative.auth.note': 'prose',
  'implementation.methods.narrative.assertsGuarantees': 'guarantee tokens', 'implementation.methods.narrative.condition': 'prose',
  'implementation.methods.narrative.on': 'prose', 'implementation.methods.narrative.cases.value': 'a case value', 'implementation.methods.narrative.over': 'prose',
  'implementation.methods.narrative.catches.error': 'an error name', 'implementation.methods.narrative.branches.name': 'a branch name',
  'implementation.methods.narrative.outcome': 'prose', 'implementation.methods.narrative.error': 'an error name',
  'implementation.methods.intent': 'prose', 'implementation.methods.exportedVia': 'a code-level export name',
  'type.fields.name': 'a field name', 'type.fields.description': 'prose', 'type.fields.previousNames': 'a field rename trace, carried verbatim',
  'type.fields.references': 'an ERD foreign-key hint (`table.field`), never bound by the loader',
  'type.methods.params.name': 'a parameter name', 'type.methods.params.description': 'prose', 'type.methods.params.previousNames': 'a parameter rename trace, carried verbatim',
  'type.componentClass': 'matched by name within its own project and never qualified: it cannot name across a boundary',
  'type.invariants.id': 'the invariant\'s own id', 'type.invariants.description': 'prose',
  'type.database': 'a database id of its own L0', 'type.table': 'a table name', 'type.linkedEntity': 'an ERD hint, never bound by the loader',
  'type.params.name': 'a parameter name', 'type.params.description': 'prose', 'type.params.previousNames': 'a parameter rename trace, carried verbatim', 'type.values.name': 'an enum value', 'type.values.description': 'prose',
  'type.holds': 'a primitive',
};

const SCHEMAS: Record<Kind, unknown> = {
  system: SystemSpecSchema, subsystem: SubsystemSpecSchema, component: ComponentSpecSchema,
  interface: InterfaceSpecSchema, implementation: ImplementationSpecSchema, type: TypeSpecSchema,
};

/** Every string leaf of a zod schema (a string, or a list of strings), by dotted path. */
function stringLeaves(schema: unknown, at = '', out = new Set<string>()): Set<string> {
  const def = (schema as { _def?: Record<string, any> })._def;
  switch (def?.typeName) {
    case 'ZodOptional': case 'ZodNullable': case 'ZodDefault': return stringLeaves(def.innerType, at, out);
    case 'ZodEffects': return stringLeaves(def.schema, at, out);
    case 'ZodLazy': return stringLeaves(def.getter(), at, out);
    case 'ZodArray': return stringLeaves(def.type, at, out);
    case 'ZodObject': {
      const shape = def.shape();
      for (const key of Object.keys(shape)) stringLeaves(shape[key], at ? `${at}.${key}` : key, out);
      return out;
    }
    case 'ZodUnion': for (const o of def.options) stringLeaves(o, at, out); return out;
    case 'ZodDiscriminatedUnion': for (const o of def.options.values ? [...def.options.values()] : def.options) stringLeaves(o, at, out); return out;
    case 'ZodString': out.add(at); return out;
    default: return out;
  }
}

/** The reason a leaf is not a reference, by its exact key or its `*.` suffix; undefined when none is given. */
function notAReference(kind: Kind, leaf: string): string | undefined {
  // `*.x`: the top-level field x of every kind; `**.x`: a field x at any depth.
  return NOT_A_REFERENCE[`${kind}.${leaf}`]
    ?? Object.entries(NOT_A_REFERENCE).find(([k]) => (k.startsWith('**.') && (leaf === k.slice(3) || leaf.endsWith(`.${k.slice(3)}`)))
      || (k.startsWith('*.') && !k.startsWith('**.') && leaf === k.slice(2)))?.[1];
}

describe('the reference-position table — enumerated against the spec schemas', () => {
  it('every string a spec schema holds is classified exactly once: a reference position, or not a reference with its reason', () => {
    const unclassified: string[] = [];
    const both: string[] = [];
    for (const kind of Object.keys(SCHEMAS) as Kind[]) {
      for (const leaf of stringLeaves(SCHEMAS[kind])) {
        const isRef = REFERENCE_POSITIONS.some((p) => p.kind === kind && p.path === leaf);
        const isNot = notAReference(kind, leaf) !== undefined;
        if (!isRef && !isNot) unclassified.push(`${kind}.${leaf}`);
        if (isRef && isNot) both.push(`${kind}.${leaf}`);
      }
    }
    expect(unclassified, 'a schema field no table classifies — decide whether a migration must respell it').toEqual([]);
    expect(both).toEqual([]);
  });

  it('every reference position names a field the schema holds (no stale row)', () => {
    const stale = REFERENCE_POSITIONS.filter((p) => !stringLeaves(SCHEMAS[p.kind]).has(p.path)).map((p) => `${p.kind}.${p.path}`);
    expect(stale).toEqual([]);
  });

  it('the type-expression rows are exactly the code\'s one table (TYPE_EXPRESSION_PATHS)', () => {
    for (const kind of ['interface', 'type'] as const) {
      const rows = REFERENCE_POSITIONS.filter((p) => p.kind === kind && p.position === 'type').map((p) => p.path).sort();
      expect(rows, kind).toEqual([...TYPE_EXPRESSION_PATHS[kind]].sort());
    }
  });
});

// ── end to end: every position read by the scan and respelled by the writer ──

describe('every reference position is recorded by the scan and respelled by the migration writer', () => {
  const cleanups: (() => void)[] = [];
  let restore: () => void;
  beforeEach(() => {
    restore = isolateGlobals(cleanups);
  });
  afterEach(() => {
    restore();
    for (const c of cleanups.splice(0).reverse()) c();
    invalidateSpecCache();
  });

  const STAMP = '2026-10-06T00:00:00.000Z';
  const m = (path_: string, kind: Kind = 'component'): string => REFERENCE_POSITIONS.find((p) => p.path === path_ && p.kind === kind)!.marker;

  /** One project holding every reference position, each with its own marker. */
  function plant(root: string): void {
    projectYaml(root, { id: 'zz', name: 'Zz' });
    const put = (file: string, doc: unknown): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, yaml.dump(doc));
    };
    put(specs(root, '.index.yaml'), SystemSpecSchema.parse({
      schemaVersion: '1.0.0', name: 'Zz', vision: 'Every reference position, once', boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP,
      publicInterfaces: [
        { from: m('publicInterfaces.from', 'system'), component: m('publicInterfaces.component', 'system'), interface: m('publicInterfaces.interface', 'system'), audience: 'project' },
        { from: 'zz-sys-reexport', typeDef: m('publicInterfaces.typeDef', 'system'), audience: 'project' },
        { subsystem: m('publicInterfaces.subsystem', 'system'), component: 'zz-legacy-target', audience: 'project' },
      ],
    }));
    put(specs(root, 'zz-sub', '.index.yaml'), SubsystemSpecSchema.parse({
      id: 'zz-sub', name: 'zz-sub', description: 'd', parentSystem: 'Zz', status: 'complete', createdAt: STAMP, updatedAt: STAMP,
      publicInterfaces: [
        { type: 'Custom', details: 'd', component: m('publicInterfaces.component', 'subsystem'), interface: m('publicInterfaces.interface', 'subsystem'), consumers: [m('publicInterfaces.consumers', 'subsystem')] },
        { from: m('publicInterfaces.from', 'subsystem'), typeDef: m('publicInterfaces.typeDef', 'subsystem') },
      ],
      lifecycle: [{ phase: 'init', component: m('lifecycle.component', 'subsystem'), method: 'start' }],
      trustedLinks: [{ subsystem: m('trustedLinks.subsystem', 'subsystem'), reason: 'a fast lane' }],
    }));
    put(specs(root, 'zz-sub', 'zz-c', '.index.yaml'), ComponentSpecSchema.parse({
      id: 'zz-c', name: 'zz-c', description: 'd', subsystem: m('subsystem'), componentType: 'Portal', transport: 'Custom', status: 'complete', createdAt: STAMP, updatedAt: STAMP,
      owns: [m('owns')], dependsOn: [m('dependsOn')],
      dispatch: [{ capability: 'cap', component: m('dispatch.component'), method: 'run' }],
    }));
    put(specs(root, 'zz-sub', 'zz-c', '.interface.yaml'), InterfaceSpecSchema.parse({
      id: 'izz-c', name: 'izz-c', description: 'd', component: m('component', 'interface'), status: 'complete', createdAt: STAMP, updatedAt: STAMP,
      methods: [
        { name: 'prose', description: 'd', signature: `prose(): ${m('methods.signature', 'interface')}`, returns: 'void' },
        { name: 'structured', description: 'd', params: [{ name: 'p', type: m('methods.params.type', 'interface') }], returns: m('methods.returns', 'interface') },
        { name: 'sourced', description: 'd', signatureFrom: m('methods.signatureFrom', 'interface') },
      ],
    }));
    put(specs(root, 'zz-sub', 'zz-c', '.implementation.yaml'), ImplementationSpecSchema.parse({
      id: 'zz-c_impl', name: 'zz-c_impl', description: 'd', contract: m('contract', 'implementation'), status: 'complete', createdAt: STAMP, updatedAt: STAMP,
      methods: [
        {
          name: 'structured',
          narrative: [{
            stepNumber: 1, type: 'call', description: 'd', targetComponent: m('methods.narrative.targetComponent', 'implementation'), targetMethod: 'run',
            auth: { from: m('methods.narrative.auth.from', 'implementation') }, assertsInvariants: [m('methods.narrative.assertsInvariants', 'implementation')],
          }],
        },
        { name: 'prose', detail: 'intent', intent: 'Does it', narrative: [], calls: [m('methods.calls', 'implementation')] },
      ],
    }));
    put(specs(root, 'types', 'zz-t.yaml'), TypeSpecSchema.parse({
      kind: 'value-object', id: 'zz-t', name: 'zz-t', description: 'd', subsystem: m('subsystem', 'type'), group: m('group', 'type'), createdAt: STAMP, updatedAt: STAMP,
      fields: [{ name: 'f', type: m('fields.type', 'type'), description: 'd', optional: false }],
      methods: [
        { name: 'prose', signature: `prose(): ${m('methods.signature', 'type')}`, returns: 'void' },
        { name: 'structured', params: [{ name: 'p', type: m('methods.params.type', 'type') }], returns: m('methods.returns', 'type') },
      ],
    }));
    put(specs(root, 'types', 'zz-s.yaml'), TypeSpecSchema.parse({
      kind: 'signature', id: 'zz-s', name: 'zz-s', description: 'd', fields: [], methods: [], createdAt: STAMP, updatedAt: STAMP,
      params: [{ name: 'p', type: m('params.type', 'type') }], returns: m('returns', 'type'),
    }));
  }

  /** The spec of a kind holding a row's marker: its id as the writer addresses it. */
  const specOf = (p: Position): string => {
    if (p.kind === 'system') return 'system';
    if (p.kind === 'subsystem') return 'zz-sub';
    if (p.kind === 'component') return 'zz-c';
    if (p.kind === 'interface') return 'izz-c';
    if (p.kind === 'implementation') return 'zz-c_impl';
    return p.path === 'params.type' || p.path === 'returns' ? 'zz-s' : 'zz-t';
  };
  /** The token inside a marker the position reads: an auth source's component, a declared call's or an invariant's type head. */
  const token = (p: Position): string => {
    if (p.path === 'methods.narrative.auth.from') return p.marker.slice('component:'.length);
    if (p.path === 'methods.calls') return p.marker.slice(0, p.marker.lastIndexOf('.'));
    if (p.path === 'methods.narrative.assertsInvariants') return p.marker.slice(0, p.marker.lastIndexOf('.'));
    return p.marker;
  };

  it('the scan records every `::` marker at its position', () => {
    const root = tempDir(cleanups, 'wairon-refpos-');
    plant(root);
    invalidateSpecCache();
    setProjectRoot(root);
    const recorded = projectFamily().authoredReferences.map((r) => `${r.position}|${r.authored}`);
    const missed = REFERENCE_POSITIONS.filter((p) => p.scanned && !recorded.includes(`${p.position}|${token(p)}`)).map((p) => `${p.kind}.${p.path} (${p.position}|${token(p)})`);
    expect(missed).toEqual([]);
  });

  it('the respelling writer rewrites every marker at its position, and nothing else', () => {
    const root = tempDir(cleanups, 'wairon-refpos-');
    plant(root);
    const seen = new Set<string>();
    for (const p of REFERENCE_POSITIONS) {
      const from = token(p);
      const to = from.includes('::') ? from.replace('::', '::re-') : `re-${from}`;
      if (seen.has(`${p.kind}|${from}`)) continue;
      seen.add(`${p.kind}|${from}`);
      invalidateSpecCache();
      setProjectRoot(root);
      const kind = p.kind as WritableSpecKind;
      expect(() => rewriteReferences(kind, specOf(p), [{ kind, specId: specOf(p), position: p.position, from, to }]), `${p.kind}.${p.path}`).not.toThrow();
    }
    // Every marker now reads its respelled text, and no original remains anywhere.
    const texts = fs.readdirSync(specs(root), { recursive: true }).map(String).filter((f) => f.endsWith('.yaml'))
      .map((f) => fs.readFileSync(specs(root, f), 'utf8')).join('\n');
    // The interface's component and the implementation's contract keep naming the specs they load beside: their ids remain.
    const left = REFERENCE_POSITIONS.filter((p) => p.marker !== 'zz-c' && p.marker !== 'izz-c').filter((p) => new RegExp(`(^|[^a-z:-])${token(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z-])`, 'm').test(texts))
      .map((p) => `${p.kind}.${p.path}`);
    expect(left).toEqual([]);
  });
});
