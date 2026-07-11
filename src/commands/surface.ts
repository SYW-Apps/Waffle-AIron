import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { assertProjectInitialized } from '../config/loader.js';
import {
  exportSurface,
  importSurface,
  listSnapshots,
  generateChildSnapshots,
} from '../core/surfaces.js';
import { SURFACE_AUDIENCES, SurfaceOrigin } from '../models/index.js';

// ---------------------------------------------------------------------------
// CLI Surfaces Client Adapter + `wairon surface` (sdd_cli → sdd_surfaces)
//
// export           — project the own L0 gateway surface (native | openapi)
// import           — store a foreign surface (native snapshot or OpenAPI)
// list             — stored snapshots available to this project
// generate-children — write the family surface into every chained child
// ---------------------------------------------------------------------------

export interface SurfaceOptions {
  audience?: string;
  format?: string;
  out?: string;
  source?: string;
  origin?: string;
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
      const result = exportSurface(audience, format, options.out);
      logger.success(
        `Projected surface of "${result.snapshot.projectName}": ${result.snapshot.interfaces.length} interface(s), ${result.snapshot.types.length} type(s) at audience ≥ ${audience}.`,
      );
      if (result.writtenTo) {
        logger.info(`Written to ${result.writtenTo}`);
      } else if (result.rendered) {
        process.stdout.write(`${result.rendered}\n`);
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

    case 'generate-children': {
      const written = generateChildSnapshots();
      if (!written.length) {
        logger.info('No chained child projects found — nothing to generate.');
        return;
      }
      logger.success(`Wrote the family surface into ${written.length} chained child project(s):`);
      for (const p of written) logger.info(`  ${p}`);
      return;
    }

    default:
      throw new WaironError(`Unknown surface action "${action}" (supported: export, import, list, generate-children).`);
  }
}
