import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { assertProjectInitialized } from '../config/paths.js';
import {
  diffSurface,
  exportDesign,
  exportSurface,
  importSurface,
  listSnapshots,
} from './adapters/surfaces.js';
// cli_lock_adapter.checkApproval: the one approval verdict the tool has (lock-check's).
import { checkApproval } from './lock.js';
// cli_validator_adapter.validateProject: the owner's gate an export is judged by.
import { validateProject } from './validate.js';
import { loadProjectConfig } from './adapters/core.js';
import { SURFACE_AUDIENCES, SurfaceOrigin, type DesignApproval, type DesignExport, type SurfaceChange } from '../models/index.js';
import type { SurfaceDiff } from '../core/surfaces.js';

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
  /** diff: what to compare with — a git revision or a saved native snapshot file; the last committed approval when omitted. */
  against?: string;
  /** diff: print the structured answer. */
  json?: boolean;
}

/**
 * A status line of `surface export`, on stderr: stdout carries the document
 * and nothing else, so `wairon surface export --format openapi > api.json`
 * writes JSON.
 */
function status(mark: 'ok' | 'warn' | 'info', message: string): void {
  const icon = mark === 'ok' ? chalk.green('✔') : mark === 'warn' ? chalk.yellow('⚠') : chalk.cyan('ℹ');
  process.stderr.write(`${icon}  ${mark === 'warn' ? chalk.yellow(message) : message}\n`);
}

/**
 * Step 3 of export: the codes of every error the owner's gate finds in the
 * bound project (cli_validator_adapter.validateProject), one entry per
 * finding; empty when the design passes or there is nothing to judge.
 */
function exportGateErrors(): string[] {
  try {
    const config = loadProjectConfig();
    const result = validateProject({ rules: config?.rules, projectType: config?.projectType }, config?.projectType);
    return result.issues.filter((i) => i.severity === 'error').map((i) => i.code);
  } catch {
    return [];
  }
}

/** One changelog line per change, grouped by kind as release notes read. */
function printSurfaceDiff(diff: SurfaceDiff): void {
  logger.info(`Public surface of "${diff.project}" against ${diff.against}:`);
  if (!diff.changes.length) {
    logger.info('  no change — every exported name, method and signature is as it was.');
    return;
  }
  const order: SurfaceChange['kind'][] = ['removed', 'renamed', 'changed', 'added'];
  const colour = { removed: chalk.red, renamed: chalk.yellow, changed: chalk.yellow, added: chalk.green } as const;
  for (const kind of order) {
    for (const c of diff.changes.filter((x) => x.kind === kind)) {
      logger.info(`  ${colour[kind](kind.padEnd(7))} ${chalk.cyan(c.member ? `${c.name}.${c.member}` : c.name)} — ${c.detail}`);
    }
  }
  const breaking = diff.changes.filter((c) => c.kind !== 'added').length;
  logger.info(chalk.gray(`${diff.changes.length} change(s), ${breaking} a consumer may have to follow. Who uses what: \`wairon externals consumers --search <dir>\`.`));
}

export async function runSurface(action: string, options: SurfaceOptions = {}): Promise<void> {
  assertProjectInitialized();

  switch (action) {
    case 'export': {
      const format = options.format ?? 'native';
      // An OpenAPI document is the project's own service document by default:
      // every HTTP Portal it has (the `project` audience). A wider --audience
      // narrows it to what the export table shares at that audience.
      const audience = options.audience ?? (format === 'openapi' ? 'project' : 'instance');
      if (!(SURFACE_AUDIENCES as readonly string[]).includes(audience)) {
        throw new WaironError(`Unknown audience "${audience}" (levels: ${SURFACE_AUDIENCES.join(' < ')}).`);
      }
      if (format !== 'native' && format !== 'openapi') {
        throw new WaironError(`Unknown format "${format}" (supported: native, openapi).`);
      }
      if (options.portal && format !== 'openapi') {
        throw new WaironError('`--portal` selects one OpenAPI document and only applies to `--format openapi`.');
      }
      let result;
      try {
        result = exportSurface(audience, format, options.out, options.portal);
      } catch (e) {
        if (e instanceof Error && (e.name === 'OpenApiNotApplicableError' || e.name === 'OpenApiRouteCollisionError')) throw new WaironError(e.message);
        throw e;
      }
      // An OpenAPI export with no HTTP Portal to describe: say so, never print the native entries as if they were it.
      if (format === 'openapi' && (result.renderedSet ?? []).length === 0) {
        throw new WaironError(`OpenAPI does not apply to "${result.snapshot.projectName}": it exposes no HTTP Portal at audience ≥ ${audience}${result.snapshot.interfaces.length ? ` — its ${result.snapshot.interfaces.length} exported interface(s) are ${[...new Set(result.snapshot.interfaces.map((e) => e.type))].join(', ')}, which no OpenAPI document describes` : ''}. Export the native snapshot (\`--format native\`) instead.`);
      }
      // Step 3: the owner's gate — an export of a design the gate refuses never reads as a success.
      const gateErrors = exportGateErrors();
      // Step 4: every status line on stderr, so a document printed to stdout is the document alone.
      const projected = `Projected surface of "${result.snapshot.projectName}": ${result.snapshot.interfaces.length} interface(s), ${result.snapshot.types.length} type(s) at audience ≥ ${audience}`;
      if (result.snapshot.interfaces.length === 0 && result.snapshot.types.length === 0) {
        status('warn', `${projected} — it publishes nothing at that audience: no entry of the L0 export table resolves to a component or a type (\`wairon validate\` names an entry that publishes nothing as EXPORT_INVALID). Publish a Portal or a type in a subsystem's publicInterfaces and export it at L0, or widen --audience.`);
      } else if (gateErrors.length > 0) {
        status('warn', `${projected} — from a design the gate refuses.`);
      } else if ((result.unresolvedTypes ?? []).length > 0) {
        status('warn', `${projected} — with types the document cannot describe.`);
      } else {
        status('ok', `${projected}.`);
      }
      // A schema the document could not resolve is named, gate errors or not: a client generator gets nothing for it.
      const unresolved = result.unresolvedTypes ?? [];
      if (unresolved.length > 0) {
        status('warn', `The document has no schema for ${unresolved.length} type(s) it names: ${unresolved.join(', ')}. Each reads "Unresolved type" where a client generator expects a schema: pin the external it comes from (\`wairon externals pin\`), or export the type from the member's or external's L0.`);
      }
      if (gateErrors.length > 0) {
        const codes = [...new Set(gateErrors)].map((c) => `${c}${gateErrors.filter((x) => x === c).length > 1 ? ` ×${gateErrors.filter((x) => x === c).length}` : ''}`).join(', ');
        status('warn', `The design has ${gateErrors.length} error(s) (${codes}): the exported document describes a design \`wairon validate\` refuses — it may name what no server can serve. Fix them, then export again.`);
      }

      // Report EVERY written path: a multi-portal OpenAPI export writes one file
      // per portal, and naming only the first would silently hide the other APIs.
      const written = result.writtenPaths ?? (result.writtenTo ? [result.writtenTo] : []);
      if (written.length === 1) {
        status('info', `Written to ${written[0]}`);
      } else if (written.length > 1) {
        status('info', `Written ${written.length} document(s) — one per portal:`);
        for (const p of written) status('info', `  ${p}`);
      } else if (result.rendered) {
        process.stdout.write(`${result.rendered}\n`);
      } else if (result.renderedSet && result.renderedSet.length > 1) {
        // An OpenAPI document IS one API. With several portals and no selection
        // there is no single document to print — name them so the caller can pick.
        status('info',
          `This project publishes ${result.renderedSet.length} portals — pick one with \`--portal <id>\` (or use --out to write them all):`,
        );
        for (const spec of result.renderedSet) {
          status('info', `  ${chalk.cyan(spec.portalId)} — ${spec.name}`);
        }
      } else {
        for (const entry of result.snapshot.interfaces) {
          status('info', `  ${chalk.cyan(entry.id)} (${entry.type}, ${entry.audience}) — ${entry.methods.length} method(s)`);
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

    case 'diff': {
      // What the export table changed since the last approval (or a named revision / saved snapshot).
      // A comparison that cannot be made (no git work tree, a ref naming no
      // commit, no approval ever committed) is refused in one line, never a
      // stack trace.
      let diff: SurfaceDiff;
      try {
        diff = diffSurface(options.against);
      } catch (e) {
        if (e instanceof WaironError) throw e;
        throw new WaironError(e instanceof Error ? e.message : String(e));
      }
      if (options.json) process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
      else printSurfaceDiff(diff);
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
      throw new WaironError(`Unknown surface action "${action}" (supported: export, import, list, diff). \`surface pin\` and \`surface externals\` are gone: declare the producer under \`externals\` in .wai/project.yaml and use \`wairon externals pin|status|list\`.`);
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
