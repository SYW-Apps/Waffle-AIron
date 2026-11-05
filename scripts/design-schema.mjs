// The design export's JSON Schema (schemas/design-export-<major>.json), generated from
// the zod schema in src/models/design-export.ts with zod's built-in
// z.toJSONSchema. Run AFTER `tsup` (it reads DesignExportSchema from the built
// library entry, dist/index.js); `npm run build` does. The drift test
// (tests/models/design-export-schema.test.ts) calls designExportJsonSchema with
// the SOURCE zod schema and fails when the committed file says anything else.
//
// The file name carries the format's MAJOR version: one major is emitted at a
// time, and a minor only adds, so a 1.x document validates against this file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The schema file for one format major, relative to the package root. */
export const designSchemaPath = (major) => resolve(root, 'schemas', `design-export-${major}.json`);

/** The JSON Schema of the design export, from its zod schema and format version. */
export function designExportJsonSchema(DesignExportSchema, formatVersion) {
  const major = formatVersion.split('.')[0];
  // zod 4's built-in generator. `io: 'input'` describes what a document may hold (a
  // defaulted field is optional); the root sits under `definitions.DesignExport`
  // behind a `$ref`, the shape this file has always had.
  // A recursive type comes back as a named definition beside the root; it is hoisted
  // so every `#/definitions/<name>` reference resolves from the document root.
  const { $schema: _draft, definitions, ...body } = z.toJSONSchema(DesignExportSchema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
    // zod 4 bounds every `int()` to the safe-integer range and says so; the schema
    // has never carried that bound, and a step number is a small integer.
    override: ({ jsonSchema }) => {
      if (jsonSchema.type === 'integer' && jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
      if (jsonSchema.type === 'integer' && jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
    },
  });
  const generated = { $ref: '#/definitions/DesignExport', definitions: { ...definitions, DesignExport: body } };
  return {
    // The draft the generator targets, declared so a validator picks the right one.
    // No $id: no URL resolves to this file for every published version, and an
    // $id that 404s pretends to be a reference it is not. Consumers address the
    // schema by its path in the package (schemas/design-export-<major>.json).
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: `wairon design export, format ${major}.x`,
    description:
      'One project\'s whole design, resolved (format `wairon-design`). A MINOR formatVersion only adds a field '
      + 'or a member of a closed set, and consumers ignore what they do not know; a MAJOR removes, renames or '
      + 'changes a meaning and is named in the CHANGELOG. Generated from the zod schema in '
      + 'src/models/design-export.ts — never edit by hand.',
    ...generated,
  };
}

/** The file's text: two-space JSON, CRLF line endings like the rest of the working tree, one trailing newline. */
export function designSchemaText(schema) {
  return `${JSON.stringify(schema, null, 2)}\n`.replace(/\r?\n/g, '\r\n');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const entry = resolve(root, 'dist', 'index.js');
  if (!existsSync(entry)) {
    console.error('[design-schema] dist/index.js not found — run tsup first.');
    process.exit(1);
  }
  const lib = createRequire(import.meta.url)(entry);
  const schema = designExportJsonSchema(lib.DesignExportSchema, lib.DESIGN_FORMAT_VERSION);
  const target = designSchemaPath(lib.DESIGN_FORMAT_VERSION.split('.')[0]);
  const text = designSchemaText(schema);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current !== text) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    console.log(`[design-schema] wrote ${target}`);
  } else {
    console.log(`[design-schema] ${target} is current`);
  }
}
