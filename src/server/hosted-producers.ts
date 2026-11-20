import { runWithProjectRoot } from '../utils/fs.js';
import { authenticateCredential, signViewToken } from './auth.js';
import { authorize } from './authorization.js';
import { existingProjectRoot } from './projects.js';
import * as hostProducer from './adapters/producer.js';
import { resolveSecret } from '../utils/secrets.js';
import type { ProducerConfig } from '../producers/index.js';
import type { HostConfig, Principal } from './types.js';
import { AdminAuthError } from './errors.js';

// ---------------------------------------------------------------------------
// Hosted Producers (sdd_host)
//
// The control-plane workflows over a hosted project's producer targets: the
// destinations its design is published to. Each workflow authenticates the
// caller, requires project:admin over the project, then configures, lists,
// removes or produces one target through the producer adapter; a target's
// token is resolved from the secret repository by reference, never passed
// inline. How each kind of target is written is the producer subsystem's.
// ---------------------------------------------------------------------------

/**
 * Authenticate the caller and require project:admin over the project (a
 * producer publishes the project's specs to an external target), then bind the
 * project's isolated root. Shared by the four producer methods.
 */
function authorizedRoot(cfg: HostConfig, credential: string | null, project: string, verb: string): string {
  const principal: Principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new AdminAuthError();
  if (authorize(cfg.dataDir, principal, 'project:admin', 'project', project).value !== 'yes') {
    throw new AdminAuthError(`Forbidden — ${verb} requires project:admin over the project`);
  }
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  return root;
}

/** hosted_producers.configure — configure a producer target (tokens come from the secret store by ref, never inline). */
export function configure(cfg: HostConfig, credential: string | null, project: string, target: string, parentPageId: string): void {
  const root = authorizedRoot(cfg, credential, project, 'configuring a producer');
  runWithProjectRoot(root, () => hostProducer.configure(target, parentPageId));
}

/** hosted_producers.produce — mint a signed canvas link and project the project to the target. */
export async function produce(cfg: HostConfig, credential: string | null, project: string, target: string): Promise<void> {
  const root = authorizedRoot(cfg, credential, project, 'running a producer');
  const base = process.env['WAIRON_PUBLIC_URL'] || `http://${cfg.host}:${cfg.port}`;
  const diagramUrl = `${base}/view/diagram?token=${signViewToken(project, 'canvas')}`;
  // The host resolves the target's token from its own secret repository and
  // hands it to the one call it authorizes; the producer never asks for it. An
  // unconfigured target needs no token: the producer refuses it by name.
  const configured = runWithProjectRoot(root, () => hostProducer.list()).some((p) => p.target === target);
  const token = configured ? resolveSecret(`${target}-token`) : null;
  if (configured && !token) {
    const label = target.charAt(0).toUpperCase() + target.slice(1);
    throw new Error(`No ${label} token — set WAIRON_${target.toUpperCase()}_TOKEN or run \`wairon host secret set ${target}-token <secret>\`.`);
  }
  await runWithProjectRoot(root, () => hostProducer.produce(target, diagramUrl, token ?? ''));
}

/** hosted_producers.remove — remove a producer target. */
export function remove(cfg: HostConfig, credential: string | null, project: string, target: string): void {
  const root = authorizedRoot(cfg, credential, project, 'removing a producer');
  runWithProjectRoot(root, () => hostProducer.remove(target));
}

/** hosted_producers.list — list the project's configured producers. */
export function list(cfg: HostConfig, credential: string | null, project: string): ProducerConfig[] {
  const root = authorizedRoot(cfg, credential, project, 'listing producers');
  return runWithProjectRoot(root, () => hostProducer.list());
}
