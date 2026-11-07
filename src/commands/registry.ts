import { http } from '../io/index.js';

// ---------------------------------------------------------------------------
// pack_registry_adapter — the client of the wairon pack registry's HTTP API
// (registry v1): resolve a name and a range to one exact version, and publish
// an archive. It owns the wire format — the base URL, the paths (a scoped name
// is two path segments), the bearer token and the refusal shape — so the pack
// commands deal in names, versions and results only.
// ---------------------------------------------------------------------------

/** The registry wairon talks to unless WAIRON_REGISTRY names another. */
export const DEFAULT_REGISTRY = 'https://wairon.sywapps.com/registry';

/** registry_publisher — the account that published a pack version. */
export interface RegistryPublisher {
  handle: string;
  verified: boolean;
}

/** registry_resolution — a name and a range resolved to one exact version. */
export interface RegistryResolution {
  name: string;
  range: string;
  version: string;
  integrity: string;
  archiveDigest: string;
  kind: string;
  minWaironVersion?: string;
  yanked: boolean;
  yankReason?: string;
  archiveUrl: string;
  source: string;
  verifiedAtPublish: boolean;
  publisher: RegistryPublisher;
  newerIncompatible?: string;
}

/** registry_publish_result — what the registry answers to a publish. */
export interface RegistryPublishResult {
  status: 'published' | 'exists' | 'refused';
  name: string;
  version: string;
  integrity?: string;
  url?: string;
  code?: string;
  message?: string;
}

/** The registry base URL: WAIRON_REGISTRY, else the default, without a trailing slash. */
function registryBase(): string {
  return (process.env.WAIRON_REGISTRY?.trim() || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

/**
 * ipack_registry_adapter.isRegistrySource — whether a recorded pack source is
 * this registry's archive template, so sync resolves it for the trust check.
 */
export function isRegistrySource(source: string): boolean {
  return source.startsWith(`${registryBase()}/v1/packs/`);
}

/** A pack name as URL path segments: `@scope/pack` is two, a flat name one. */
function namePath(name: string): string {
  const scoped = /^@([^/]+)\/(.+)$/.exec(name);
  return scoped
    ? `@${encodeURIComponent(scoped[1])}/${encodeURIComponent(scoped[2])}`
    : encodeURIComponent(name);
}

interface RegistryError {
  code?: string;
  message?: string;
  details?: { findings?: unknown[]; integrity?: string } & Record<string, unknown>;
}

/** The `{ error: { code, message, details } }` body of a refusal, or an empty one. */
async function errorOf(response: Response): Promise<RegistryError> {
  try {
    const body = (await response.json()) as { error?: RegistryError };
    return body?.error ?? {};
  } catch {
    return {};
  }
}

/** A refusal's message, each validation finding appended. */
function describe(error: RegistryError, status: number): string {
  const base = error.message ?? `the registry answered ${status}`;
  const findings = (error.details?.findings ?? []).map((f) =>
    typeof f === 'string' ? f : (f as { message?: string })?.message ?? JSON.stringify(f));
  return findings.length > 0 ? `${base}\n${findings.map((f) => `  - ${f}`).join('\n')}` : base;
}

/** Send a request, turning a network failure into a plain "could not reach" error. */
async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await http.request(url, init);
  } catch (e) {
    throw new Error(`Could not reach the wairon pack registry at ${registryBase()}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * ipack_registry_adapter.resolve — resolve a pack name and a range (`*` when
 * none) to one exact version, sending the running wairon's version so versions
 * needing a later wairon are skipped.
 */
export async function resolve(name: string, range: string, waironVersion: string): Promise<RegistryResolution> {
  // Step 1: the URL.
  const query = new URLSearchParams({ range: range || '*', wairon: waironVersion });
  const url = `${registryBase()}/v1/packs/${namePath(name)}/resolve?${query.toString()}`;
  // Step 2: the GET.
  const response = await send(url, { headers: { accept: 'application/json' } });
  // Steps 3-4: anything but a resolution is a refusal.
  if (response.status !== 200) {
    const error = await errorOf(response);
    if (response.status === 404) {
      throw new Error(`${name}${range && range !== '*' ? `@${range}` : ''}: ${describe(error, 404)} (${error.code ?? 'NOT_FOUND'})`);
    }
    throw new Error(`The wairon pack registry could not resolve ${name}: ${describe(error, response.status)}${error.code ? ` (${error.code})` : ''}`);
  }
  // Step 5.
  return (await response.json()) as RegistryResolution;
}

/**
 * ipack_registry_adapter.publish — publish one archive under its name and
 * version with a registry token. Answers published, exists (with the stored
 * integrity) or refused; throws only when the registry cannot be reached.
 */
export async function publish(name: string, version: string, archive: Uint8Array, token: string): Promise<RegistryPublishResult> {
  // Step 1: the URL.
  const url = `${registryBase()}/v1/packs/${namePath(name)}/${encodeURIComponent(version)}`;
  // Step 2: the PUT.
  const response = await send(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/zip', authorization: `Bearer ${token}`, accept: 'application/json' },
    body: archive,
  });
  // Step 3: read the answer.
  if (response.status === 201 || response.status === 200) {
    const body = (await response.json()) as { integrity?: string; url?: string };
    return { status: 'published', name, version, integrity: body.integrity, url: body.url };
  }
  const error = await errorOf(response);
  if (response.status === 409) {
    return { status: 'exists', name, version, integrity: error.details?.integrity, code: error.code, message: error.message };
  }
  if (response.status >= 500) {
    throw new Error(`The wairon pack registry failed to publish ${name}@${version}: ${describe(error, response.status)}`);
  }
  // Step 4.
  return { status: 'refused', name, version, code: error.code ?? String(response.status), message: describe(error, response.status) };
}
