import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ProjectConfigSchema } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// Round 7 (lib-and-app R7-3): docs/cli.md tells a team which project.yaml
// settings exist — `rules.conformance.requireCode: true`, `composition.
// requireApprovedMembers`, … — and a setting spelled as the docs spell it must
// be one the configuration schema reads. A documented key the schema does not
// know configures nothing (the parse drops it), so the docs and the schema
// must agree, key by key. This reads every backticked dotted key in cli.md
// whose first segment is a top-level project.yaml key and walks it through the
// schema.
// ---------------------------------------------------------------------------

const CLI_MD = path.resolve(__dirname, '..', '..', 'docs', 'cli.md');

/** The schema one level down a dotted key, or null when that segment is not a setting. */
function child(schema: z.ZodTypeAny, segment: string): z.ZodTypeAny | null {
  const s = unwrap(schema);
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    return shape[segment] ?? null;
  }
  // A record's keys are the author's own (an alias, a code): any key reads.
  if (s instanceof z.ZodRecord) return s.valueSchema as z.ZodTypeAny;
  if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) {
    for (const option of s.options as z.ZodTypeAny[]) {
      const found = child(option, segment);
      if (found) return found;
    }
  }
  return null;
}

/** Strip the wrappers that do not change which keys a value has. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
    else if (s instanceof z.ZodDefault) s = s._def.innerType;
    else if (s instanceof z.ZodEffects) s = s.innerType();
    else if (s instanceof z.ZodLazy) s = s.schema;
    else return s;
  }
}

/** Every documented project.yaml key in cli.md: `a.b.c` or `a.b.c: value`, a file name never. */
function documentedKeys(): string[] {
  const text = fs.readFileSync(CLI_MD, 'utf8');
  const tops = new Set(Object.keys(ProjectConfigSchema.shape));
  const keys = [...text.matchAll(/`([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)(?::[^`]*)?`/g)]
    .map((m) => m[1])
    .filter((key) => tops.has(key.split('.')[0]))
    .filter((key) => !/\.(ya?ml|json|md|ts|js)$/.test(key));
  return [...new Set(keys)].sort();
}

describe('docs/cli.md and the project.yaml schema agree on every documented setting (round 7)', () => {
  const keys = documentedKeys();

  it('finds the documented settings (the extraction itself works)', () => {
    expect(keys).toContain('rules.conformance.requireCode');
    expect(keys).toContain('composition.requireApprovedMembers');
  });

  for (const key of keys) {
    it(`\`${key}\` is a setting the schema reads`, () => {
      let schema: z.ZodTypeAny | null = ProjectConfigSchema;
      for (const segment of key.split('.')) {
        schema = schema ? child(schema, segment) : null;
        expect(schema, `"${segment}" of ${key} is not in the project.yaml schema`).not.toBeNull();
      }
    });
  }

  it('the documented `rules.conformance.requireCode: true` parses and is KEPT (never dropped as unknown)', () => {
    const parsed = ProjectConfigSchema.parse({
      name: 'docs', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
      rules: { conformance: { requireCode: true } },
    });
    expect(parsed.rules.conformance?.requireCode).toBe(true);
  });
});
