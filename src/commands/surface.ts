import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { assertProjectInitialized } from '../config/loader.js';
import {
  exportSurface,
  importSurface,
  listSnapshots,
  listExternalInterfaces,
  pinFamilySurfaces,
} from '../core/surfaces.js';
import { SURFACE_AUDIENCES, SurfaceOrigin } from '../models/index.js';

// ---------------------------------------------------------------------------
// CLI Surfaces Client Adapter + `wairon surface` (sdd_cli → sdd_surfaces)
//
// export           — project the own L0 gateway surface (native | openapi)
// import           — store a foreign surface (native snapshot or OpenAPI)
// list             — stored snapshots available to this project
// externals        — the project's consumable external surfaces (parent
//                    family, siblings, foreign imports) with freshness
// pin              — a chained child pulls its parent's family and sibling
//                    surfaces into its own .wai/surfaces/, on its own schedule
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

    case 'externals': {
      const entries = listExternalInterfaces();
      if (!entries.length) {
        logger.info('No external surfaces available (.wai/surfaces/ holds no snapshots).');
        return;
      }
      // One row per entry: sourceKind, key, origin, freshness, interface ids.
      const freshness = (f: string): string =>
        f === 'fresh' ? chalk.green(f) : f === 'stale' ? chalk.yellow(f) : chalk.gray(f);
      for (const e of entries) {
        logger.info(
          `${e.sourceKind.padEnd(8)} ${chalk.cyan(e.projectName)} [${e.origin}] ${freshness(e.freshness)} — ` +
            `${e.interfaceIds.length ? e.interfaceIds.join(', ') : '(no interfaces)'}`,
        );
      }
      return;
    }

    case 'pin': {
      // Only CHANGED paths come back; null means this root has no parent at all.
      const written = pinFamilySurfaces();
      if (written === null) {
        logger.info('This project is not a chained subproject — there is no parent family to pin.');
        return;
      }
      if (!written.length) {
        logger.info('Pinned family surfaces are already up to date — nothing rewritten.');
        return;
      }
      logger.success(`Pinned ${written.length} family surface(s) from the parent:`);
      for (const p of written) logger.info(`  ${p}`);
      return;
    }

    default:
      throw new WaironError(`Unknown surface action "${action}" (supported: export, import, list, externals, pin).`);
  }
}
