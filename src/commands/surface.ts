import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { assertProjectInitialized } from '../config/paths.js';
import {
  exportDesign,
  exportSurface,
  importSurface,
  listSnapshots,
} from './adapters/surfaces.js';
// cli_lock_adapter.checkApproval: the one approval verdict the tool has (lock-check's).
import { checkApproval } from './lock.js';
import { SURFACE_AUDIENCES, SurfaceOrigin, type DesignApproval, type DesignExport } from '../models/index.js';

// ---------------------------------------------------------------------------
// `wairon surface` (sdd_cli → sdd_surfaces, through the surfaces client adapter)
//
// export           — project the own L0 gateway surface (native | openapi)
// import           — store a foreign surface (native snapshot or OpenAPI)
// list             — stored snapshots available to this project
//
// `surface pin` and `surface externals` are gone (stage 3): a project consumes
// another through `externals` in .wai/project.yaml and `wairon externals`.
// ---------------------------------------------------------------------------

export interface SurfaceOptions {
  audience?: string;
  format?: string;
  out?: string;
  source?: string;
  origin?: string;
  /** OpenAPI export: select ONE portal's document. An OpenAPI spec is one API,
   *  so a multi-portal project renders one document per portal. */
  portal?: string;
}

export async function runSurface(action: string, options: SurfaceOptions = {}): Promise<void> {
  assertProjectInitialized();

  switch (action) {
    case 'export': {
      const audience = options.audience ?? 'instance';
      if (!(SURFACE_AUDIENCES as readonly string[]).includes(audience)) {
        throw new WaironError(`Unknown audience "${audience}" (levels: ${SURFACE_AUDIENCES.join(' < ')}).`);
      }
      const format = options.format ?? 'native';
      if (format !== 'native' && format !== 'openapi') {
        throw new WaironError(`Unknown format "${format}" (supported: native, openapi).`);
      }
      if (options.portal && format !== 'openapi') {
        throw new WaironError('`--portal` selects one OpenAPI document and only applies to `--format openapi`.');
      }
      const result = exportSurface(audience, format, options.out, options.portal);
      logger.success(
        `Projected surface of "${result.snapshot.projectName}": ${result.snapshot.interfaces.length} interface(s), ${result.snapshot.types.length} type(s) at audience ≥ ${audience}.`,
      );

      // Report EVERY written path: a multi-portal OpenAPI export writes one file
      // per portal, and naming only the first would silently hide the other APIs.
      const written = result.writtenPaths ?? (result.writtenTo ? [result.writtenTo] : []);
      if (written.length === 1) {
        logger.info(`Written to ${written[0]}`);
      } else if (written.length > 1) {
        logger.info(`Written ${written.length} document(s) — one per portal:`);
        for (const p of written) logger.info(`  ${p}`);
      } else if (result.rendered) {
        process.stdout.write(`${result.rendered}\n`);
      } else if (result.renderedSet && result.renderedSet.length > 1) {
        // An OpenAPI document IS one API. With several portals and no selection
        // there is no single document to print — name them so the caller can pick.
        logger.info(
          `This project publishes ${result.renderedSet.length} portals — pick one with \`--portal <id>\` (or use --out to write them all):`,
        );
        for (const spec of result.renderedSet) {
          logger.info(`  ${chalk.cyan(spec.portalId)} — ${spec.name}`);
        }
      } else {
        for (const entry of result.snapshot.interfaces) {
          logger.info(`  ${chalk.cyan(entry.id)} (${entry.type}, ${entry.audience}) — ${entry.methods.length} method(s)`);
        }
      }
      return;
    }

    case 'import': {
      if (!options.source) throw new WaironError('`--source <path>` (the surface document to import) is required.');
      const origin = (options.origin ?? 'authored') as SurfaceOrigin;
      if (origin !== 'exchanged' && origin !== 'authored') {
        throw new WaironError(`Unknown origin "${options.origin}" (an import is exchanged or authored; generated snapshots come from the producing project).`);
      }
      const snapshot = importSurface(options.source, origin);
      logger.success(
        `Imported ${origin} surface "${snapshot.projectName}": ${snapshot.interfaces.length} interface(s), ${snapshot.types.length} type(s)${snapshot.version ? ` @ ${snapshot.version}` : ''}.`,
      );
      return;
    }

    case 'list': {
      const snapshots = listSnapshots();
      if (!snapshots.length) {
        logger.info('No surface snapshots stored (.wai/surfaces/ is empty).');
        return;
      }
      for (const s of snapshots) {
        const provenance = s.stateId ?? s.version ?? 'unversioned';
        logger.info(
          `${chalk.cyan(s.projectName)} [${s.origin}] — ${s.interfaces.length} interface(s), ${s.types.length} type(s), ${provenance} (${s.generatedAt})`,
        );
      }
      return;
    }

    default:
      throw new WaironError(`Unknown surface action "${action}" (supported: export, import, list). \`surface pin\` and \`surface externals\` are gone: declare the producer under \`externals\` in .wai/project.yaml and use \`wairon externals pin|status|list\`.`);
  }
}

// ---------------------------------------------------------------------------
// `wairon export [--out <file>]` (cli_runner.runExport → sdd_surfaces)
//
// The bound project's whole design, resolved, as one JSON document (the design
// export). Its approval verdict is the one `wairon lock-check` exits on, decided
// FIRST against the gate identity (not strict) and handed to the export: an
// unapproved tree still exports, carrying its state (stale, unlocked) for the
// consumer to judge. A repository with no spec tree is refused — there is no
// design to export, and an empty document would read as one.
//
// Without --out the JSON goes to stdout and NOTHING else does, so it pipes into
// a generator.
// ---------------------------------------------------------------------------

export async function runExport(out?: string): Promise<void> {
  // Step 1: the lock-check verdict, not strict.
  const verdict = checkApproval(false);
  if (verdict.state === 'no-tree') {
    throw new WaironError(
      'Nothing to export: there is no SDD spec tree here (.wai/specs holds no L0 system spec). '
        + 'Run `wairon init` to start one, or run `wairon export` from a project root.',
    );
  }
  const approval: DesignApproval = verdict.state;

  // Step 2: the export, with that verdict's state, written to --out when given.
  const design = exportDesign(out, approval);

  // Steps 3-4: the path written and whether the exported design is approved.
  const members = memberNote(design);
  if (out) {
    logger.success(
      `Design export of "${design.project.name}" written to ${path.resolve(out)} `
        + `(${design.components.length} component(s), ${design.types.length} type(s); approval: ${design.source.approval}).`,
    );
    if (members) logger.info(members);
    return;
  }
  // Step 5: the deterministic JSON on stdout, and nothing else. A project that
  // holds no design of its own but has members says why on stderr, so a pipe
  // still reads only the JSON.
  process.stdout.write(`${JSON.stringify(design, null, 2)}\n`);
  if (members && design.components.length === 0 && design.types.length === 0) process.stderr.write(`${members}\n`);
}

/**
 * The member projects an export lists under `dependencies` and never inlines
 * (each is a project of its own, exported from its own root), named so the
 * export of a family's top that holds no design of its own does not read as
 * empty by mistake. Null when the project has no member projects.
 */
function memberNote(design: DesignExport): string | null {
  const members = design.dependencies.filter((d) => d.role === 'member').map((d) => d.alias);
  if (members.length === 0) return null;
  return `${members.length} member project(s) are listed under \`dependencies\`, not inlined (${members.join(', ')}): `
    + 'run `wairon export` in a member\'s own root for its design.';
}
