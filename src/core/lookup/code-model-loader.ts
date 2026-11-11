import { createHash } from 'crypto';
import {
  loadImplementationSpecs,
  loadTypeSpecs,
  loadProjectConfig,
} from '../adapters/validator-core.js';
import { buildCodeModel, compilerIdentity, sourceFiles } from '../source-analysis.js';
import * as contentFingerprint from '../content-fingerprint.js';
import * as cache from './code-model-cache.js';
import { getProjectRoot } from '../../utils/fs.js';
import type { CachedCodeModel } from '../../models/lookup.js';
import type { ImplementationSpec, TypeSpec } from '../../models/specs.js';

/**
 * The code model a lookup or the validator's gate reads, never older than the
 * files on disk as their content fingerprint sees them.
 */
export function current(): CachedCodeModel {
  const projectRoot = getProjectRoot();
  const implementations = loadImplementationSpecs();
  const types = loadTypeSpecs();
  const conformance = loadProjectConfig()?.rules?.conformance;
  return modelFor(implementations, types, projectRoot, conformance?.sourceRoots ?? [], conformance?.exclude ?? []);
}

/**
 * The fingerprint a code model built for these specs is held under: the
 * content of every file the model reads, with the files the implementations
 * claim folded in.
 */
export function fingerprint(
  implementations: ImplementationSpec[],
  types: TypeSpec[],
  projectRoot: string,
  sourceRoots: readonly string[] = [],
  exclude: readonly string[] = [],
): string {
  const set = sourceFiles(implementations, types, projectRoot, sourceRoots, exclude);
  const content = contentFingerprint.digest(projectRoot, set.files);
  // Step 3: the compiler an exact reading takes, so installing, upgrading or
  // removing TypeScript changes the fingerprint.
  const compiler = compilerIdentity(projectRoot);
  return createHash('sha256').update(JSON.stringify([content, compiler, set.files, set.claimed])).digest('hex');
}

/**
 * The code model for these specs: the cached entry when its fingerprint
 * matches theirs, else a fresh build, held in the cache and answered. The
 * model answered is shared: a caller never changes it.
 */
export function modelFor(
  implementations: ImplementationSpec[],
  types: TypeSpec[],
  projectRoot: string,
  sourceRoots: readonly string[] = [],
  exclude: readonly string[] = [],
): CachedCodeModel {
  const taken = fingerprint(implementations, types, projectRoot, sourceRoots, exclude);
  const held = cache.get(projectRoot);
  if (held && held.fingerprint === taken) return held;
  const model = buildCodeModel(implementations, types, projectRoot, sourceRoots, exclude);
  const entry: CachedCodeModel = { fingerprint: taken, model, builtAt: new Date().toISOString() };
  cache.put(projectRoot, entry);
  return entry;
}
