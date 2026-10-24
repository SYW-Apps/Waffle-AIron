import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import { factsFor } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// source_analysis_adapter.buildCodeModel step 6: whether decorator metadata
// applies to a file is decided by its nearest tsconfig.json, read through the
// compiler's own config reader (extends followed). A decorated annotation is a
// value use under metadata (never a type-position-only binding) and an
// ordinary type position without it. No tsconfig, an unreadable one, an
// unresolvable extends or a solution-style one keeps metadata ON.
// ---------------------------------------------------------------------------

const DECORATED =
  "import { Dep } from './dep';\nfunction Injectable(): ClassDecorator { return () => undefined; }\n@Injectable()\nexport class Orch {\n  constructor(private readonly dep: Dep) {}\n}\n";
const DEP = 'export class Dep {}\n';

/** Whether the file's `Dep` import reads as type-position-only under the given extra files. */
const typeOnly = (extra: Record<string, string>, target = 'src/orch.ts'): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-decmeta-'));
  try {
    const files = { 'src/orch.ts': DECORATED, 'src/dep.ts': DEP, ...extra };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    const model = buildCodeModel([], [], dir, ['src']);
    return (factsFor(model, target)!.typePositionOnlyBindings ?? []).includes('Dep');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
};

describe('decorator metadata follows the nearest tsconfig', () => {
  it('fire: emitDecoratorMetadata true keeps a decorated annotation a value use', () => {
    expect(typeOnly({ 'tsconfig.json': '{"compilerOptions":{"emitDecoratorMetadata":true,"experimentalDecorators":true}}' })).toBe(false);
  });

  it('fire: a tsconfig that does not turn metadata on makes the annotation an ordinary type position', () => {
    expect(typeOnly({ 'tsconfig.json': '{"compilerOptions":{"experimentalDecorators":true}}' })).toBe(true);
    expect(typeOnly({ 'tsconfig.json': '{"compilerOptions":{"emitDecoratorMetadata":false}}' })).toBe(true);
  });

  it('metadata turned on in a base config reached by extends counts', () => {
    expect(typeOnly({
      'tsconfig.base.json': '{"compilerOptions":{"emitDecoratorMetadata":true}}',
      'tsconfig.json': '{"extends":"./tsconfig.base.json"}',
    })).toBe(false);
  });

  it('metadata turned off by the extending config overrides the base', () => {
    expect(typeOnly({
      'tsconfig.base.json': '{"compilerOptions":{"emitDecoratorMetadata":true}}',
      'tsconfig.json': '{"extends":"./tsconfig.base.json","compilerOptions":{"emitDecoratorMetadata":false}}',
    })).toBe(true);
  });

  it('the nearest tsconfig at or above the file wins over the root one', () => {
    expect(typeOnly({
      'tsconfig.json': '{"compilerOptions":{"emitDecoratorMetadata":true}}',
      'src/tsconfig.json': '{"compilerOptions":{"emitDecoratorMetadata":false}}',
    })).toBe(true);
  });

  it('control: no tsconfig keeps metadata on', () => {
    expect(typeOnly({})).toBe(false);
  });

  it('control: an unparseable tsconfig keeps metadata on', () => {
    expect(typeOnly({ 'tsconfig.json': '{ this is not json' })).toBe(false);
  });

  it('control: an extends that cannot be resolved keeps metadata on', () => {
    expect(typeOnly({ 'tsconfig.json': '{"extends":"./missing.json","compilerOptions":{"emitDecoratorMetadata":false}}' })).toBe(false);
  });

  it('control: a solution-style tsconfig (references, no files or include) keeps metadata on', () => {
    expect(typeOnly({ 'tsconfig.json': '{"references":[{"path":"./src"}],"compilerOptions":{"emitDecoratorMetadata":false}}' })).toBe(false);
  });
});
