import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { validateSddTree } from '../../src/core/validation.js';

const now = new Date().toISOString();

// PORTAL_AUTH_UNMET (Phase 3): a narrative call into a Portal whose auth != 'none'
// must name where its credential loads from (the step's auth.from). We filter to
// that one code so unrelated fixture findings never affect these assertions.
describe('PORTAL_AUTH_UNMET — cross-call auth conformance', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  function build(opts: {
    stepAuth?: { from: string };
    portalScheme?: string;
    stepType?: 'call' | 'dispatch';
    callerType?: string;
    callerDependsOn?: string[];
    callerAuth?: Record<string, unknown>;
    providers?: { id: string; type: string }[];
  } = {}): void {
    const {
      stepAuth, portalScheme = 'bearer', stepType = 'call',
      callerType = 'Orchestrator', callerDependsOn = [], callerAuth, providers = [],
    } = opts;
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-pca-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSystemSpec({ schemaVersion: '1.0.0', name: 'Sys', vision: 't', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveSubsystemSpec({ id: 'sub', name: 'Sub', description: 'd', parentSystem: 'Sys', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now } as any);

    // The authenticated portal being called.
    saveComponentSpec({
      id: 'ext-portal', name: 'Ext', description: 'd', subsystem: 'sub', componentType: 'Portal', portalType: 'HTTP_API',
      ...(portalScheme === 'none' ? {} : { auth: { scheme: portalScheme } }),
      owns: [], dependsOn: [], createdAt: now, updatedAt: now,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    saveInterfaceSpec({
      id: 'iext-portal', name: 'IExt', description: 'd', component: 'ext-portal',
      methods: [{ name: 'fetch', description: 'fetch', signature: 'fetch(): void', returns: 'void' }],
      createdAt: now, updatedAt: now,
    });

    // Optional secret-provider components an `auth.from: component:<id>` may point at.
    for (const p of providers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveComponentSpec({ id: p.id, name: p.id, description: 'd', subsystem: 'sub', componentType: p.type, owns: [], dependsOn: [], createdAt: now, updatedAt: now } as any);
    }

    // The caller whose narrative reaches into the authed portal.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveComponentSpec({ id: 'caller', name: 'Caller', description: 'd', subsystem: 'sub', componentType: callerType, owns: [], dependsOn: callerDependsOn, ...(callerAuth ? { auth: callerAuth } : {}), createdAt: now, updatedAt: now } as any);
    saveInterfaceSpec({
      id: 'icaller', name: 'ICaller', description: 'd', component: 'caller',
      methods: [{ name: 'run', description: 'run', signature: 'run(): void', returns: 'void' }],
      createdAt: now, updatedAt: now,
    });
    const step = stepType === 'dispatch'
      ? { stepNumber: 1, description: 'route inbound through the portal', type: 'dispatch', targetComponent: 'ext-portal', capability: 'fetch' }
      : { stepNumber: 1, description: 'reach the external authed portal', type: 'call', targetComponent: 'ext-portal', targetMethod: 'fetch', ...(stepAuth ? { auth: stepAuth } : {}) };
    saveImplementationSpec({
      id: 'caller_impl', name: 'CallerImpl', description: 'd', contract: 'icaller',
      methods: [{ name: 'run', detail: 'calls-only', narrative: [step] }],
      createdAt: now, updatedAt: now,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    invalidateSpecCache();
  }

  // A gateway service whose narrative forwards to N internal authed portals — the
  // realistic microservice shape (one public gateway → internal service portals).
  function buildGateway(sources: (string | undefined)[]): void {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-pca-gw-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'Sys', vision: 't', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveSubsystemSpec({ id: 'sub', name: 'Sub', description: 'd', parentSystem: 'Sys', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now } as any);
    sources.forEach((_, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveComponentSpec({ id: `svc${i}-portal`, name: `Svc${i}`, description: 'd', subsystem: 'sub', componentType: 'Portal', portalType: 'HTTP_API', auth: { scheme: 'apiKey', in: 'header', name: 'X-Svc-Key' }, owns: [], dependsOn: [], createdAt: now, updatedAt: now } as any);
      saveInterfaceSpec({ id: `isvc${i}-portal`, name: `ISvc${i}`, description: 'd', component: `svc${i}-portal`, methods: [{ name: 'op', description: 'op', signature: 'op(): void', returns: 'void' }], createdAt: now, updatedAt: now });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveComponentSpec({ id: 'gateway', name: 'Gateway', subsystem: 'sub', description: 'd', componentType: 'Gateway', owns: [], dependsOn: [], createdAt: now, updatedAt: now } as any);
    saveInterfaceSpec({ id: 'igateway', name: 'IGateway', description: 'd', component: 'gateway', methods: [{ name: 'route', description: 'route', signature: 'route(): void', returns: 'void' }], createdAt: now, updatedAt: now });
    saveImplementationSpec({
      id: 'gateway_impl', name: 'GatewayImpl', description: 'd', contract: 'igateway',
      methods: [{
        name: 'route', detail: 'calls-only',
        narrative: sources.map((src, i) => ({ stepNumber: i + 1, description: `forward to svc${i}`, type: 'call', targetComponent: `svc${i}-portal`, targetMethod: 'op', ...(src ? { auth: { from: src } } : {}) })),
      }],
      createdAt: now, updatedAt: now,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    invalidateSpecCache();
  }

  const authIssues = (res: { issues: { code: string; severity: string; specId?: string }[] }) =>
    res.issues.filter(i => i.code === 'PORTAL_AUTH_UNMET');
  const issuesOf = (res: { issues: { code: string }[] }, code: string) =>
    res.issues.filter(i => i.code === code);

  it('warns when a narrative calls an authed portal without a credential source', () => {
    build();
    const found = authIssues(validateSddTree());
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].specId).toBe('caller_impl');
  });

  it('is satisfied when the call step declares where the credential loads from', () => {
    build({ stepAuth: { from: 'secret_store' } });
    expect(authIssues(validateSddTree())).toHaveLength(0);
  });

  it('does not fire when the callee portal needs no auth', () => {
    build({ portalScheme: 'none' });
    expect(authIssues(validateSddTree())).toHaveLength(0);
  });

  it('does not fire on a dispatch step (a portal\'s own inbound routing, not an outbound call)', () => {
    build({ stepType: 'dispatch' });
    expect(authIssues(validateSddTree())).toHaveLength(0);
  });

  it('a gateway forwarding to internal authed portals warns PER undeclared call', () => {
    buildGateway([undefined, undefined]);
    expect(authIssues(validateSddTree())).toHaveLength(2);
  });

  it('a gateway clears once every forward names where its credential loads from', () => {
    buildGateway(['config:svc0_key', 'config:svc1_key']);
    expect(authIssues(validateSddTree())).toHaveLength(0);
  });

  // --- (1a) auth belongs on a Portal, nowhere else -------------------------
  it('warns AUTH_ON_NON_PORTAL when a non-Portal component declares auth', () => {
    build({ callerType: 'Store', callerAuth: { scheme: 'apiKey', in: 'header', name: 'X-Svc-Token' } });
    expect(issuesOf(validateSddTree(), 'AUTH_ON_NON_PORTAL')).toHaveLength(1);
  });

  // --- (1b) the credential presenter must be an Adapter --------------------
  it('warns AUTH_PRESENTER_NOT_ADAPTER when a non-Adapter authenticates the outbound call', () => {
    build(); // caller is an Orchestrator
    expect(issuesOf(validateSddTree(), 'AUTH_PRESENTER_NOT_ADAPTER')).toHaveLength(1);
  });

  it('is silent on the presenter check when the caller is an Adapter', () => {
    build({ callerType: 'Adapter' });
    expect(issuesOf(validateSddTree(), 'AUTH_PRESENTER_NOT_ADAPTER')).toHaveLength(0);
  });

  // --- (2a) a component: credential source is a checked graph edge ---------
  it('flags a component: source that does not resolve (UNKNOWN_AUTH_SOURCE)', () => {
    build({ callerType: 'Adapter', stepAuth: { from: 'component:ghost' } });
    expect(issuesOf(validateSddTree(), 'UNKNOWN_AUTH_SOURCE')).toHaveLength(1);
  });

  it('flags a resolved source that is neither Adapter nor Store (AUTH_SOURCE_NOT_PROVIDER)', () => {
    build({ callerType: 'Adapter', callerDependsOn: ['aux'], providers: [{ id: 'aux', type: 'Orchestrator' }], stepAuth: { from: 'component:aux' } });
    const res = validateSddTree();
    expect(issuesOf(res, 'AUTH_SOURCE_NOT_PROVIDER')).toHaveLength(1);
    expect(issuesOf(res, 'AUTH_SOURCE_UNWIRED')).toHaveLength(0); // it IS wired
  });

  it('flags a valid provider the presenter is not wired to (AUTH_SOURCE_UNWIRED)', () => {
    build({ callerType: 'Adapter', providers: [{ id: 'vault', type: 'Adapter' }], stepAuth: { from: 'component:vault' } });
    const res = validateSddTree();
    expect(issuesOf(res, 'AUTH_SOURCE_UNWIRED')).toHaveLength(1);
    expect(issuesOf(res, 'AUTH_SOURCE_NOT_PROVIDER')).toHaveLength(0); // an Adapter is a valid provider
  });

  it('is fully satisfied when auth.from names a wired Adapter provider', () => {
    build({ callerType: 'Adapter', callerDependsOn: ['vault'], providers: [{ id: 'vault', type: 'Adapter' }], stepAuth: { from: 'component:vault' } });
    const res = validateSddTree();
    for (const code of ['PORTAL_AUTH_UNMET', 'AUTH_PRESENTER_NOT_ADAPTER', 'UNKNOWN_AUTH_SOURCE', 'AUTH_SOURCE_NOT_PROVIDER', 'AUTH_SOURCE_UNWIRED']) {
      expect(issuesOf(res, code)).toHaveLength(0);
    }
  });

  it('treats an opaque (non-component:) source as a design note, no resolution', () => {
    build({ callerType: 'Adapter', stepAuth: { from: 'config:svc_key' } });
    const res = validateSddTree();
    expect(issuesOf(res, 'UNKNOWN_AUTH_SOURCE')).toHaveLength(0);
    expect(issuesOf(res, 'PORTAL_AUTH_UNMET')).toHaveLength(0);
  });
});
