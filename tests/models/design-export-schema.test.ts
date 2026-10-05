/**
 * The shipped JSON Schema (schemas/design-export-1.json) is GENERATED from the
 * zod schema in src/models/design-export.ts at build time
 * (scripts/design-schema.mjs). This is the drift test: regenerated from the
 * SOURCE zod schema, it must say exactly what the committed file says — a
 * format change that forgot `npm run build` fails here, not in a consumer.
 */
import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DesignExportSchema, DESIGN_FORMAT_VERSION } from '../../src/models/design-export.js';
// @ts-expect-error -- a plain .mjs build script, no type declarations
import { designExportJsonSchema, designSchemaPath, designSchemaText } from '../../scripts/design-schema.mjs';

describe('the design export JSON Schema', () => {
  const major = DESIGN_FORMAT_VERSION.split('.')[0];
  const file = designSchemaPath(major) as string;

  it('is committed for the current format major', () => {
    expect(fs.existsSync(file), `${file} is missing — run \`npm run build\``).toBe(true);
  });

  it('says exactly what the zod schema says (regenerate with `npm run build`)', () => {
    const committed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(committed).toEqual(designExportJsonSchema(DesignExportSchema, DESIGN_FORMAT_VERSION));
  });

  it('is written byte-for-byte as the build writes it', () => {
    const text = designSchemaText(designExportJsonSchema(DesignExportSchema, DESIGN_FORMAT_VERSION)) as string;
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('declares its draft and claims no $id it cannot resolve', () => {
    const committed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(committed.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(committed).not.toHaveProperty('$id');
  });

  it('leaves objects open, so a newer minor still validates against it', () => {
    const closed: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (!node || typeof node !== 'object') return;
      if ((node as Record<string, unknown>).additionalProperties === false) closed.push(at);
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, `${at}/${k}`);
    };
    walk(JSON.parse(fs.readFileSync(file, 'utf8')), '#');
    expect(closed).toEqual([]);
  });
});
