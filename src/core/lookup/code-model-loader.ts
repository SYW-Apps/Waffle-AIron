import {
  loadImplementationSpecs,
  loadTypeSpecs,
  loadProjectConfig,
} from '../adapters/validator-core.js';
import { buildCodeModel, fingerprintSources } from '../source-analysis.js';
import * as cache from './code-model-cache.js';
import { getProjectRoot } from '../../utils/fs.js';
import type { CachedCodeModel } from '../../models/lookup.js';

/**
 * The code model a lookup reads, never older than the files on disk as their
 * fingerprint sees them. The validator's gate never calls this: a gate run
 * builds its own model, so the cache cannot change a verdict.
 */
export function current(): CachedCodeModel {
  const projectRoot = getProjectRoot();
  const implementations = loadImplementationSpecs();
  const types = loadTypeSpecs();
  const conformance = loadProjectConfig()?.rules?.conformance;
  const sourceRoots = conformance?.sourceRoots ?? [];
  const exclude = conformance?.exclude ?? [];
  const fingerprint = fingerprintSources(implementations, types, projectRoot, sourceRoots, exclude);
  const held = cache.get(projectRoot);
  if (held && held.fingerprint === fingerprint) return held;
  const model = buildCodeModel(implementations, types, projectRoot, sourceRoots, exclude);
  const entry: CachedCodeModel = { fingerprint, model, builtAt: new Date().toISOString() };
  cache.put(projectRoot, entry);
  return entry;
}
