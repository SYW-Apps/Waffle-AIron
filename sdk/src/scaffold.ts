import type { PackFile, PackScaffoldRequest } from './types.js';
import { SDK_VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Pack Scaffold Specialist (pack_scaffold_specialist_impl) — PURE template
// rendering for `wairon pack init`. Produces an in-memory file map; writes
// nothing. Code packs pin @wairon/sdk to the running SDK version.
// ---------------------------------------------------------------------------

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Render the scaffold file map for the requested pack (declarative or code). */
export function render(request: PackScaffoldRequest): PackFile[] {
  const version = request.version ?? '0.1.0';
  let files: PackFile[];
  // Step 1: which variant?
  if (request.kind === 'code') {
    // Step 2: render the code-pack file map.
    files = renderCodePack(request.name, version);
    // Step 3: skip the declarative variant (fall through to the skill gate).
  } else {
    // Step 4 (declVariant): render the declarative-pack file map.
    files = renderDeclarativePack(request.name, version);
  }
  // Step 5 (skillGate): include a skill stub?
  if (request.withSkill) {
    // Step 6: append a skills/<id>/SKILL.md stub to the file map.
    files.push(renderSkillStub(request.name, version));
  }
  // Step 7 (done): return the rendered file map.
  return files;
}

// --- variant renderers -----------------------------------------------------

function renderDeclarativePack(name: string, version: string): PackFile[] {
  return [
    { path: 'wairon-pack.yaml', contents: enc(declarativeEnvelope(name, version)) },
    { path: 'pack.yaml', contents: enc(declarativeManifest(name, version)) },
    { path: 'README.md', contents: enc(readme(name, 'declarative', 'pack.yaml')) },
  ];
}

function renderCodePack(name: string, version: string): PackFile[] {
  return [
    { path: 'wairon-pack.yaml', contents: enc(codeEnvelope(name, version)) },
    { path: 'package.json', contents: enc(codePackageJson(name, version)) },
    { path: 'tsconfig.json', contents: enc(codeTsconfig()) },
    { path: 'pack.ts', contents: enc(codeEntry(name, version)) },
    { path: 'README.md', contents: enc(readme(name, 'code', 'pack.cjs')) },
  ];
}

function renderSkillStub(name: string, _version: string): PackFile {
  const id = slug(name);
  return { path: `skills/${id}/SKILL.md`, contents: enc(skillStub(name)) };
}

// --- templates -------------------------------------------------------------

function declarativeEnvelope(name: string, version: string): string {
  return [
    'formatVersion: 1',
    `name: ${name}`,
    `version: ${version}`,
    'kind: declarative',
    'entry: pack.yaml',
    '',
  ].join('\n');
}

function codeEnvelope(name: string, version: string): string {
  return [
    'formatVersion: 1',
    `name: ${name}`,
    `version: ${version}`,
    'kind: code',
    'entry: pack.cjs',
    `minWaironVersion: ${SDK_VERSION}`,
    '',
  ].join('\n');
}

function declarativeManifest(name: string, version: string): string {
  return [
    `name: ${name}`,
    `version: ${version}`,
    '',
    '# Custom architectural profiles this pack contributes (example, commented):',
    '# profiles:',
    '#   my-profile:',
    '#     family: backend-like',
    '#     forbiddenStereotypes:',
    '#       - types: [Adapter]',
    '#         reason: "Domain components must not touch adapters directly."',
    'profiles: {}',
    '',
    '# Target language / platform tables (example, commented):',
    '# languages:',
    '#   rust:',
    '#     unsupportedFlow: {}',
    '#     foreignBuiltins: []',
    'languages: {}',
    '',
    '# Reusable, versioned architecture patterns:',
    'patterns: []',
    '',
  ].join('\n');
}

function codePackageJson(name: string, version: string): string {
  const pkg = {
    name,
    version,
    private: true,
    scripts: {
      build: 'esbuild pack.ts --bundle --platform=node --packages=external --format=cjs --outfile=pack.cjs',
    },
    dependencies: {
      '@wairon/sdk': SDK_VERSION,
    },
    devDependencies: {
      esbuild: '^0.21.0',
      typescript: '^5.0.0',
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function codeTsconfig(): string {
  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      module: 'CommonJS',
      moduleResolution: 'node',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: false,
      noEmit: true,
    },
    include: ['pack.ts'],
  };
  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}

function codeEntry(name: string, version: string): string {
  const code = slug(name).toUpperCase().replace(/-/g, '_');
  return [
    "import { defineRule } from '@wairon/sdk';",
    "import type { RuleContext, Finding } from '@wairon/sdk';",
    '',
    'const exampleRule = defineRule({',
    `  name: '${slug(name)}-example',`,
    "  description: 'Example architectural rule. Replace with your own doctrine.',",
    `  codes: ['${code}_EXAMPLE'],`,
    '  check(ctx: RuleContext): Finding[] {',
    '    const findings: Finding[] = [];',
    '    for (const component of ctx.components) {',
    '      // Inspect the spec tree and push findings as needed.',
    '      void component;',
    '    }',
    '    return findings;',
    '  },',
    '});',
    '',
    'export default {',
    `  name: '${name}',`,
    `  version: '${version}',`,
    '  rules: [exampleRule],',
    '};',
    '',
  ].join('\n');
}

function readme(name: string, kind: string, entry: string): string {
  return [
    `# ${name}`,
    '',
    `A wairon ${kind} pack.`,
    '',
    `- Envelope: \`wairon-pack.yaml\``,
    `- Entry: \`${entry}\``,
    '',
    'Build an installable `.wpack` archive with `wairon pack build`.',
    '',
  ].join('\n');
}

function skillStub(name: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} authoring skill (stub).`,
    '---',
    '',
    `# ${name}`,
    '',
    'Describe when this skill applies and what it guides.',
    '',
  ].join('\n');
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
