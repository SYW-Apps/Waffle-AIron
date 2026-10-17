// Generate the upgrade fixture with a PUBLISHED wairon release (no LLM).
//
//   node qa/scripts/gen-upgrade-fixture.mjs --version 5.1.0 --out tests/fixtures/upgrade-v5.1.0
//
// It installs @wairon/cli@<version> into a scratch directory, scaffolds a small
// shop project with that release's own CLI, authors the design by calling that
// release's MCP tools over stdio, takes the lock with that release, and copies the
// resulting `.wai/` trees (the project and its chained subproject) into --out.
// Run it again from a later stable to regenerate the fixture for the next upgrade.
//
// Options: --version <semver> (default 5.1.0), --out <dir> (required),
//          --work <dir> (scratch dir, default a fresh temp dir).
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const version = opt('version', '5.1.0');
const out = opt('out');
if (!out) {
  console.error('usage: gen-upgrade-fixture.mjs --version <semver> --out <dir> [--work <dir>]');
  process.exit(2);
}
const work = path.resolve(opt('work', fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-fixture-'))));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`--version must be a published release, got "${version}"`);

// Install the published release into its own folder, with a private HOME so no
// user-level config or pack store leaks into the fixture.
const tool = path.join(work, 'tool');
const home = path.join(work, 'home');
const project = path.join(work, 'shop');
fs.mkdirSync(tool, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(tool, 'package.json'), '{"name":"fixture-tool","private":true}');
execSync(`npm install @wairon/cli@${version} --no-audit --no-fund --ignore-scripts`, { cwd: tool, stdio: 'inherit' });
const cli = path.join(tool, 'node_modules', '@wairon', 'cli', 'dist', 'cli', 'index.js');
const env = {
  ...getDefaultEnvironment(), HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'),
  LOCALAPPDATA: path.join(home, 'localappdata'), WAIRON_CACHE_DIR: path.join(home, 'cache'),
};
const wairon = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: 'utf8' });

const got = wairon('--version').trim();
if (got !== version) throw new Error(`installed wairon reports ${got}, expected ${version}`);

wairon('init', '--yes');
wairon('subsystem', 'add', 'billing', '--project-path', 'services/billing');

// One MCP session per project root, like an AI tool opened in that folder.
async function open(root) {
  const client = new Client({ name: 'fixture-generator', version: '0.0.1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [cli, 'mcp', 'serve'], cwd: root,
    env: { ...env, WAIRON_PROJECT_DIR: root }, stderr: 'ignore',
  }));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
    if (res.isError) throw new Error(`${name} ${JSON.stringify(args).slice(0, 120)} failed: ${text}`);
    return text;
  };
  return { call, close: () => client.close() };
}
const parent = await open(project);
const call = parent.call;

// A method with one string-ish param, to keep the shapes short.
const method = (name, description, params, returns, extra = {}) => ({
  name, description, returns,
  signature: `${name}(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}): ${returns}`,
  params: params.map((p) => ({ ...p, description: p.description ?? `The ${p.name}` })),
  ...extra,
});
const step = (description, type, extra = {}) => ({ description, type, ...extra });

await call('sdd_initialize_system', {
  name: 'Shopfront',
  vision: 'A small online shop: browse a catalog, place orders, and bill them.',
  boundaries: ['Payments are handled by the billing service only'],
  globalRequirements: ['Every order is billed exactly once'],
  targetLanguage: 'typescript',
});

// One subsystem = Portal -> Orchestrator -> Repository(Store). The same shape twice.
async function slice({ sub, title, noun, before, extraDeps = [], extraSteps = [] }) {
  await call('sdd_add_subsystem', { id: sub, name: title, description: `${title} for the shop` });
  if (before) await before();
  const id = (s) => `${sub}-${s}`;
  await call('sdd_add_component', {
    id: id('store'), name: `${title} Store`, description: `Holds ${noun} records`,
    subsystem: sub, componentType: 'Store', durability: 'read-through',
  });
  await call('sdd_add_component', {
    id: id('repo'), name: `${title} Repository`, description: `Facade over the ${noun} store`,
    subsystem: sub, componentType: 'Repository', owns: [id('store')],
  });
  await call('sdd_add_component', {
    id: id('orch'), name: `${title} Orchestrator`, description: `Runs the ${noun} workflows`,
    subsystem: sub, componentType: 'Orchestrator', dependsOn: [id('repo'), ...extraDeps],
  });
  await call('sdd_add_component', {
    id: id('portal'), name: `${title} Portal`, description: `HTTP front door for ${noun}s`,
    subsystem: sub, componentType: 'Portal', portalType: 'HTTP_API', dependsOn: [id('orch')],
  });

  await call('sdd_define_interface', {
    id: `i${sub}-store`, name: `I${title}Store`, description: `Persistence contract for ${noun}s`,
    component: id('store'),
    methods: [
      method('save', `Persist one ${noun}`, [{ name: 'record', type: 'string' }], 'void', { effect: 'write' }),
      method('load', `Load one ${noun} by id`, [{ name: 'key', type: 'string' }], 'string', { effect: 'read' }),
    ],
  });
  await call('sdd_define_interface', {
    id: `i${sub}-repo`, name: `I${title}Repository`, description: `Facade contract for ${noun}s`,
    component: id('repo'),
    methods: [
      method('put', `Store one ${noun}`, [{ name: 'record', type: 'string' }], 'void', { effect: 'write' }),
      method('get', `Fetch one ${noun}`, [{ name: 'key', type: 'string' }], 'string', { effect: 'read' }),
    ],
  });
  await call('sdd_define_interface', {
    id: `i${sub}-orch`, name: `I${title}Orchestrator`, description: `Workflows for ${noun}s`,
    component: id('orch'),
    methods: [
      method('create', `Create one ${noun}`, [{ name: 'record', type: 'string' }], 'string'),
      method('find', `Look one ${noun} up`, [{ name: 'key', type: 'string' }], 'string'),
    ],
  });
  await call('sdd_define_interface', {
    id: `i${sub}-portal`, name: `I${title}Portal`, description: `HTTP surface for ${noun}s`,
    component: id('portal'),
    methods: [
      method('post', `Accept a new ${noun}`, [{ name: 'body', type: 'string' }], 'string'),
      method('fetch', `Return one ${noun}`, [{ name: 'key', type: 'string' }], 'string'),
    ],
  });
  await call('sdd_set_endpoints', {
    interface: `i${sub}-portal`,
    endpoints: [
      { method: 'post', transport: 'HTTP', httpMethod: 'POST', path: `/${noun}s` },
      { method: 'fetch', transport: 'HTTP', httpMethod: 'GET', path: `/${noun}s/{key}` },
    ],
  });

  const impl = (c, desc, methods) => call('sdd_write_narrative', {
    id: `${id(c)}-impl`, name: `${title} ${c} impl`, description: desc, contract: `i${sub}-${c}`, methods,
  });
  await impl('store', 'Keeps records by key', [
    { name: 'save', narrative: [step('Write the record under its key', 'local'), step('Saved', 'return', { outcome: 'success' })] },
    { name: 'load', narrative: [step('Read the record stored under the key', 'local'), step('Record returned', 'return', { outcome: 'success' })] },
  ]);
  await impl('repo', 'Delegates to the store', [
    { name: 'put', narrative: [step('Hand the record to the store', 'call', { targetComponent: id('store'), targetMethod: 'save' })] },
    { name: 'get', narrative: [step('Ask the store for the record', 'call', { targetComponent: id('store'), targetMethod: 'load' })] },
  ]);
  await impl('orch', `Runs the ${noun} workflows`, [
    {
      name: 'create',
      narrative: [
        step('Check the record is not empty', 'local'),
        ...extraSteps,
        step('Store the record', 'call', { targetComponent: id('repo'), targetMethod: 'put' }),
        step('Record accepted', 'return', { outcome: 'success' }),
      ],
    },
    { name: 'find', narrative: [step('Fetch the record', 'call', { targetComponent: id('repo'), targetMethod: 'get' }), step('Record returned', 'return', { outcome: 'success' })] },
  ]);
  await impl('portal', `Maps ${noun} routes onto the workflows`, [
    { name: 'post', narrative: [step('Create the record', 'call', { targetComponent: id('orch'), targetMethod: 'create' }), step('Respond 201', 'return', { outcome: 'success' })] },
    { name: 'fetch', narrative: [step('Look the record up', 'call', { targetComponent: id('orch'), targetMethod: 'find' }), step('Respond 200', 'return', { outcome: 'success' })] },
  ]);
}

await slice({ sub: 'catalog', title: 'Catalog', noun: 'product' });

// The chained subproject, in v5.1.0's own form: the child is a project of its own,
// designed from its own root (L0, a subsystem, a published Portal); the parent
// mounts it as an L1 subsystem and reaches its published components as billing::<component>.
const childRoot = path.join(project, 'services', 'billing');
const child = await open(childRoot);
await child.call('sdd_initialize_system', {
  name: 'Billing',
  vision: 'Charges orders once and records the charge.',
  targetLanguage: 'typescript',
});
await child.call('sdd_add_subsystem', { id: 'charges', name: 'Charges', description: 'Charging workflow' });
await child.call('sdd_add_component', {
  id: 'billing-orch', name: 'Billing Orchestrator', description: 'Charges an order once',
  subsystem: 'charges', componentType: 'Orchestrator',
});
await child.call('sdd_add_component', {
  id: 'billing-portal', name: 'Billing Portal', description: 'HTTP front door for charges',
  subsystem: 'charges', componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['billing-orch'],
});
await child.call('sdd_define_interface', {
  id: 'ibilling-orch', name: 'IBillingOrchestrator', description: 'Charge workflow',
  component: 'billing-orch',
  methods: [method('charge', 'Charge one order', [{ name: 'orderId', type: 'string' }], 'string')],
});
await child.call('sdd_define_interface', {
  id: 'ibilling-portal', name: 'IBillingPortal', description: 'HTTP surface for charges',
  component: 'billing-portal',
  methods: [method('postCharge', 'Accept a charge request', [{ name: 'orderId', type: 'string' }], 'string')],
});
await child.call('sdd_set_endpoints', {
  interface: 'ibilling-portal',
  endpoints: [{ method: 'postCharge', transport: 'HTTP', httpMethod: 'POST', path: '/charges' }],
});
await child.call('sdd_write_narrative', {
  id: 'billing-orch-impl', name: 'Billing orch impl', description: 'Charges once', contract: 'ibilling-orch',
  methods: [{ name: 'charge', narrative: [step('Record the charge for the order', 'local'), step('Charged', 'return', { outcome: 'success' })] }],
});
await child.call('sdd_write_narrative', {
  id: 'billing-portal-impl', name: 'Billing portal impl', description: 'Maps the route', contract: 'ibilling-portal',
  methods: [{ name: 'postCharge', narrative: [step('Run the charge', 'call', { targetComponent: 'billing-orch', targetMethod: 'charge' }), step('Respond 201', 'return', { outcome: 'success' })] }],
});
await child.call('sdd_set_public_interfaces', {
  subsystem: 'charges',
  publicInterfaces: [{ type: 'REST', details: 'POST /charges', component: 'billing-portal', interface: 'ibilling-portal' }],
});
await child.close();

// The orders workflow charges through a local client Adapter that calls the chained Portal.
await slice({
  sub: 'orders', title: 'Orders', noun: 'order', extraDeps: ['orders-billing-client'],
  extraSteps: [step('Charge the order', 'call', { targetComponent: 'orders-billing-client', targetMethod: 'charge' })],
  before: async () => {
    await call('sdd_add_component', {
      id: 'orders-billing-client', name: 'Billing Client', description: 'Calls the billing service',
      subsystem: 'orders', componentType: 'Adapter', dependsOn: ['billing::billing-portal'],
    });
    await call('sdd_define_interface', {
      id: 'iorders-billing-client', name: 'IBillingClient', description: 'Client contract for charging',
      component: 'orders-billing-client',
      methods: [method('charge', 'Charge one order', [{ name: 'orderId', type: 'string' }], 'string')],
    });
    await call('sdd_write_narrative', {
      id: 'orders-billing-client-impl', name: 'Billing client impl', description: 'Forwards to billing',
      contract: 'iorders-billing-client',
      methods: [{ name: 'charge', narrative: [step('Ask billing to charge', 'call', { targetComponent: 'billing::billing-portal', targetMethod: 'postCharge' }), step('Charged', 'return', { outcome: 'success' })] }],
    });
  },
});

const text = await call('sdd_validate_tree', {});
console.log(text.slice(0, 1500));
await parent.close();

console.log(wairon('lock', '--yes'));
console.log(wairon('validate'));

// The approver identity is the machine user; replace it so the committed record names no one.
const lockFile = path.join(project, '.wai', 'lock.json');
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
lock.lockedBy = 'qa-fixture';
fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(project, '.wai'), path.join(out, '.wai'), { recursive: true });
fs.cpSync(path.join(project, 'services', 'billing', '.wai'), path.join(out, 'services', 'billing', '.wai'), { recursive: true });
console.log(`fixture written to ${out}`);
