import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
// validator_core_adapter: the configuration, the loader over a candidate and one entry's manifest.
import { loadProjectConfig, loadExtensionsFor, packManifest, loadSubsystemSpecs } from './adapters/validator-core.js';
// rule_repository: wairon's own rule set, registered alone.
import { registerBuiltinRules, knownIssueCodes } from './rules/repository.js';
// spec_validator: the owner's gate, and the builtin profiles and project kinds.
import { validateProject, builtinProfileIds, builtinProjectKinds, type ProjectVerdict, type ValidationResult } from './validation.js';
import type { ExtensionPack } from './extensions.js';
import {
  effectiveProjectId,
  withPack,
  ComponentTypeSchema,
  RETIRED_STEREOTYPES,
  SEMANTIC_GUARANTEES,
  type PackEntry,
  type PackSelection,
  type ProjectConfig,
} from '../models/index.js';
import {
  doctrineChanges,
  findingChanges,
  type DoctrineBaseline,
  type DoctrineChange,
  type PackCandidate,
  type PackDoctrine,
  type PackImpact,
} from '../models/pack-impact.js';

// ---------------------------------------------------------------------------
// pack_impact — what one pack write would change on the bound project,
// measured before it happens (governance stage).
//
// The candidate is never written: it is project_config.withPack over the
// loaded configuration — the reading the registry's write uses — and the dry
// validate runs the owner's gate with every configuration input taken from it
// (rules, projectType, pack selections and the extensions loaded for it), so
// the report's finding changes equal what validation reports after the write
// (impact-matches-apply). It judges nothing: a pack that loosens wairon's
// checks is reported as changing them, never as a finding. The rule registry
// it re-registers is the per-run registration every validation performs.
// ---------------------------------------------------------------------------

/** The authorable building blocks and patterns: every component type but the retired ones. */
function authorableStereotypes(): string[] {
  return ComponentTypeSchema.options.filter((t) => !RETIRED_STEREOTYPES.has(t));
}

/**
 * wairon's defaults, precisely: the builtin rule set registered alone (no
 * pack rule), its codes at their default severities, the builtin profiles and
 * project kinds, the authorable stereotypes, the builtin guarantee tokens and
 * the default design depth.
 */
function defaultsBaseline(): DoctrineBaseline {
  // Register the builtin rules alone, so the registry holds wairon's own rule set.
  registerBuiltinRules();
  // Every builtin code with its default severity.
  const ruleDefaults: Record<string, string> = {};
  for (const code of knownIssueCodes()) ruleDefaults[code.code] = code.defaultSeverity;
  return {
    ruleDefaults,
    profiles: builtinProfileIds(),
    projectKinds: builtinProjectKinds(),
    stereotypes: authorableStereotypes(),
    guarantees: [...SEMANTIC_GUARANTEES],
    designDepth: 'narratives',
  };
}

/** Whether a configured entry names the same pack as the candidate's (a selection by name, a path by equality). */
function sameEntry(a: PackEntry, b: PackEntry): boolean {
  if (typeof b === 'string') return a === b;
  return typeof a !== 'string' && a.name === b.name;
}

/** A pack entry named for a report: a selection's name, a path reference's file stem. */
function entryName(entry: PackEntry): string {
  return typeof entry === 'string' ? path.basename(entry).replace(/\.(ya?ml|cjs|js)$/i, '') : entry.name;
}

/** The reason the gate would give an entry that does not resolve. */
function unresolvedReason(config: ProjectConfig, entry: PackEntry): string {
  const alone: ProjectConfig = { ...config, extensions: { useGlobalPacks: false, packs: [entry] } };
  const loaded = loadExtensionsFor(alone);
  const failure = loaded.selectionFailures[0];
  if (failure) return `[${failure.code}] ${failure.message}`;
  return loaded.errors[0] ?? `the pack "${entryName(entry)}" does not resolve`;
}

/** One run's totals as a project verdict line — the owner's gate of the bound project. */
function totals(config: ProjectConfig, result: ValidationResult): ProjectVerdict {
  const count = (severity: string): number => result.issues.filter((i) => i.severity === severity).length;
  const id = effectiveProjectId(config);
  return {
    key: '',
    ...(id !== null ? { id } : {}),
    directory: getProjectRoot(),
    valid: result.valid,
    errors: count('error'),
    warnings: count('warning'),
    notices: count('notice'),
  };
}

/** The pack's profiles that govern something under a configuration: its projectType and each subsystem profile. */
function governingProfiles(manifest: ExtensionPack | null, config: ProjectConfig): string[] {
  if (!manifest) return [];
  const named = [config.projectType, ...loadSubsystemSpecs().map((s) => s.profile ?? '')];
  return [...new Set(named.filter((p) => p !== '' && p in manifest.profiles))];
}

/**
 * ipack_impact.measure — measure a pack write on the bound project without
 * performing it: the candidate configuration built with withPack, the pack's
 * manifest (supplied, else resolved) and, on an update, the one applied now;
 * wairon's defaults and each manifest's changes against them; then the owner's
 * gate under the stored and under the candidate configuration, and the finding
 * changes between them. Never the family run. Throws when the bound project
 * has no configuration or the candidate pack does not resolve. Writes nothing.
 */
export function measure(candidate: PackCandidate): PackImpact {
  // Step 1: the stored configuration.
  const config = loadProjectConfig();
  // Steps 2-3: a pack applies to a project.
  if (!config) throw new Error('Not inside a wairon project: a pack impact is measured on a project — run `wairon init` first.');
  // Step 4: the candidate, in memory only; the same-name entry applied now.
  const entry = candidate.entry;
  const remove = candidate.remove === true;
  let next = entry !== undefined ? withPack(config, entry, remove) : config;
  if (candidate.projectType !== undefined) next = { ...next, projectType: candidate.projectType };
  const current = entry !== undefined ? (config.extensions?.packs ?? []).find((e) => sameEntry(e, entry)) : undefined;
  // Steps 5-9: the manifest measured — supplied, none, or resolved the loader's way.
  let manifest: ExtensionPack | null = null;
  if ((candidate.manifest && !remove) || entry === undefined) {
    manifest = candidate.manifest ?? null;
  } else {
    const measured = remove ? (current ?? entry) : entry;
    manifest = packManifest(measured);
    if (!manifest) throw new Error(`Cannot measure the pack: ${unresolvedReason(config, measured)}`);
  }
  // Steps 10-11: on an update, the manifest applied now.
  const previous = !remove && current !== undefined ? packManifest(current) : null;
  // Steps 12-16: wairon's defaults and the changes against them.
  const baseline = defaultsBaseline();
  const doctrine = manifest ? doctrineChanges(manifest, baseline) : [];
  const previousDoctrine: DoctrineChange[] | undefined = previous ? doctrineChanges(previous, baseline) : undefined;
  // Step 17: the owner's gate under the stored configuration.
  const before = validateProject({ rules: config.rules, projectType: config.projectType });
  // Step 18: the extensions the candidate configuration would apply.
  const extensions = loadExtensionsFor(next, candidate);
  // Step 19: the owner's gate again, every configuration input from the candidate.
  const after = validateProject({
    rules: next.rules,
    projectType: next.projectType,
    extensions,
    packSelections: (next.extensions?.packs ?? []).filter((e): e is PackSelection => typeof e !== 'string'),
  });
  // Steps 20-21: the subsystem profiles read (governingProfiles), the diff, both totals, the direction and the replaced version.
  const replaces = previous?.version ?? (current !== undefined && typeof current !== 'string' ? current.version : undefined);
  // Step 22.
  return {
    pack: manifest?.name ?? (entry !== undefined ? entryName(entry) : `projectType ${next.projectType}`),
    ...(manifest?.version ? { version: manifest.version } : {}),
    ...(!remove && current !== undefined && replaces ? { replaces } : {}),
    direction: remove ? 'remove' : 'apply',
    doctrine,
    ...(previousDoctrine && !remove ? { previousDoctrine } : {}),
    governing: governingProfiles(manifest, remove ? config : next),
    findings: findingChanges(before, after),
    before: totals(config, before),
    after: totals(next, after),
  };
}

/**
 * ipack_impact.doctrine — the doctrine half alone, for a pack no project
 * exists to validate against: wairon's defaults built exactly as measure
 * builds them, and the manifest's changes against them. Writes nothing.
 */
export function doctrine(manifest: ExtensionPack): PackDoctrine {
  // Steps 1-4: wairon's defaults.
  const baseline = defaultsBaseline();
  // Step 5: the manifest's changes against them.
  const changes = doctrineChanges(manifest, baseline);
  // Step 6.
  return { pack: manifest.name, ...(manifest.version ? { version: manifest.version } : {}), changes };
}
