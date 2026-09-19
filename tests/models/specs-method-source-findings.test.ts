import { describe, it, expect } from 'vitest';
import {
  FindingDeclarationSchema,
  ImplementationSpecSchema,
  MethodImplementationSchema,
  MethodSignatureSchema,
  implementationSourceFiles,
  methodSourceFile,
  parseDeclaredCall,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// A method can name its own source file (method_implementation.sourcePath), and
// a contract method declares the finding codes it reports
// (method_signature.findings of finding_declaration). The two type methods,
// implementation_spec.sourceFiles and method_implementation.sourceFile, are the
// shared lookup every consumer of a source path reads.
// ---------------------------------------------------------------------------

const now = '2026-09-13T10:00:00.000Z';

const signature = (over: Record<string, unknown> = {}) => ({
  name: 'validate',
  description: 'Runs the rule',
  signature: 'validate(): Finding[]',
  returns: 'Finding[]',
  ...over,
});

const issueMessages = (result: { success: boolean; error?: { issues: { message: string }[] } }): string[] =>
  result.success ? [] : result.error!.issues.map((i) => i.message);

describe('method_implementation.sourcePath', () => {
  it('a method implementation keeps its own sourcePath', () => {
    const parsed = MethodImplementationSchema.parse({ name: 'run', sourcePath: 'src/commands/run.ts' });
    expect(parsed.sourcePath).toBe('src/commands/run.ts');
  });

  it('an implementation spec keeps each method sourcePath beside its own', () => {
    const parsed = ImplementationSpecSchema.parse({
      id: 'cli_runner_impl', name: 'CLI runner', description: 'd', contract: 'icli_runner',
      sourcePath: 'src/cli/index.ts',
      methods: [
        { name: 'run', sourcePath: 'src/commands/run.ts' },
        { name: 'help' },
      ],
      createdAt: now, updatedAt: now,
    });
    expect(parsed.sourcePath).toBe('src/cli/index.ts');
    expect(parsed.methods.map((m) => m.sourcePath)).toEqual(['src/commands/run.ts', undefined]);
  });
});

describe('method_signature.findings', () => {
  const findings = [
    { code: 'UNREALIZED_FINDING', severity: 'error', summary: 'A declared finding code never appears in the source file' },
    { code: 'MYPACK_SLOW_QUERY', severity: 'warning', summary: 'A pack-prefixed code' },
  ];

  it('a contract method keeps its declared findings', () => {
    const parsed = MethodSignatureSchema.parse(signature({ findings }));
    expect(parsed.findings).toEqual(findings);
  });

  it('refuses a finding code that is not UPPER_SNAKE', () => {
    const result = FindingDeclarationSchema.safeParse({ code: 'unrealized_finding', severity: 'error', summary: 's' });
    expect(result.success).toBe(false);
    expect(issueMessages(result).join('\n')).toMatch(/UPPER_SNAKE/);
  });

  it('refuses a finding code declared twice in one method, naming the code', () => {
    const result = MethodSignatureSchema.safeParse(signature({
      findings: [
        { code: 'DUPLICATE_CODE', severity: 'error', summary: 'first' },
        { code: 'DUPLICATE_CODE', severity: 'warning', summary: 'second' },
      ],
    }));
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toEqual(['Finding code "DUPLICATE_CODE" is declared more than once in this method']);
  });

  it('refuses an unknown severity', () => {
    const result = FindingDeclarationSchema.safeParse({ code: 'SOME_CODE', severity: 'notice', summary: 's' });
    expect(result.success).toBe(false);
  });

  it('refuses an empty summary', () => {
    const result = FindingDeclarationSchema.safeParse({ code: 'SOME_CODE', severity: 'warning', summary: '' });
    expect(result.success).toBe(false);
  });

  it('the same code may be declared by two different methods', () => {
    const one = MethodSignatureSchema.safeParse(signature({ findings: [findings[0]] }));
    const two = MethodSignatureSchema.safeParse(signature({ name: 'other', findings: [findings[0]] }));
    expect(one.success && two.success).toBe(true);
  });
});

describe('implementation_spec.sourceFiles', () => {
  it('lists the implementation sourcePath, then each method sourcePath, deduplicated in declaration order', () => {
    expect(implementationSourceFiles({
      sourcePath: 'src/cli/index.ts',
      methods: [
        { sourcePath: 'src/commands/run.ts' },
        {},
        { sourcePath: 'src/cli/index.ts' },
        { sourcePath: 'src/commands/help.ts' },
        { sourcePath: 'src/commands/run.ts' },
      ],
    })).toEqual(['src/cli/index.ts', 'src/commands/run.ts', 'src/commands/help.ts']);
  });

  it('lists method files when the implementation names none, and never the simPath', () => {
    const impl = ImplementationSpecSchema.parse({
      id: 'x_impl', name: 'x', description: 'd', contract: 'ix',
      simPath: 'tests/sim/x.sim.ts',
      methods: [{ name: 'run', sourcePath: 'src/x/run.ts' }],
      createdAt: now, updatedAt: now,
    });
    expect(implementationSourceFiles(impl)).toEqual(['src/x/run.ts']);
    expect(implementationSourceFiles({ methods: [] })).toEqual([]);
  });
});

describe('method_implementation.sourceFile', () => {
  it("is the method's own sourcePath when it names one", () => {
    expect(methodSourceFile({ sourcePath: 'src/commands/run.ts' }, 'src/cli/index.ts')).toBe('src/commands/run.ts');
  });

  it("is the implementation's sourcePath otherwise, else none", () => {
    expect(methodSourceFile({}, 'src/cli/index.ts')).toBe('src/cli/index.ts');
    expect(methodSourceFile({})).toBeUndefined();
  });
});

describe('method_implementation.calls', () => {
  it('reads one entry apart at the LAST dot, so a namespaced component id survives', () => {
    expect(parseDeclaredCall('credential_store.read')).toEqual({ compId: 'credential_store', methodName: 'read' });
    expect(parseDeclaredCall('billing::invoice_store.save')).toEqual({ compId: 'billing::invoice_store', methodName: 'save' });
  });

  it('answers null for anything that is not <component>.<method>', () => {
    expect(parseDeclaredCall('credential_store')).toBeNull();
    expect(parseDeclaredCall('.read')).toBeNull();
    expect(parseDeclaredCall('credential_store.')).toBeNull();
  });

  it('is kept on a method whose narrative shows no steps', () => {
    const parsed = ImplementationSpecSchema.parse({
      id: 'x_impl', name: 'x', description: 'd', contract: 'ix',
      methods: [{ name: 'read', calls: ['store.load'] }],
      createdAt: now, updatedAt: now,
    });
    expect(parsed.methods[0].calls).toEqual(['store.load']);
  });

  it('is REFUSED beside a narrative — the steps already say what is called', () => {
    const result = ImplementationSpecSchema.safeParse({
      id: 'x_impl', name: 'x', description: 'd', contract: 'ix',
      methods: [{
        name: 'read',
        calls: ['store.load'],
        narrative: [{ stepNumber: 1, description: 'read through the store', type: 'call', targetComponent: 'store', targetMethod: 'load' }],
      }],
      createdAt: now, updatedAt: now,
    });
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toEqual([
      'Method "read" declares calls AND a narrative — `calls` says what a method calls when its narrative does not show it, and this one has 1 step(s) that already do. Add the call step, or drop the declaration.',
    ]);
  });
});
