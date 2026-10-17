/**
 * technology.packages — the package names the code twin of the leakage rule
 * (TECH_LEAKAGE_IN_CODE) compares an import's package name with.
 *
 * A design names a technology the way people say it (`postgres`), while the
 * code imports its driver (`pg`). Comparing only the declared tokens left the
 * code fence inert on an ordinary design, so this module carries a CURATED,
 * DOCUMENTED table of the common packages each technology is known by, keyed by
 * the technology's usual spellings. It is deliberately short: a package belongs
 * here only when importing it can mean nothing BUT that technology. An HTTP
 * client (fetch, axios, got, undici) is never a technology — it is how an
 * Adapter reaches anything — so no entry names one.
 *
 * Extending it takes no code change: a technology written `{ name, matches }`
 * adds its own tokens, and a loaded pack contributes packages per technology
 * name (an extension pack's `technologyPackages`).
 */
import { technologyName, technologyTokens, type Technology } from './specs.js';

/** The common packages of one technology. */
interface TechnologyPackageEntry {
  /** The names a design writes the technology under, lower-case. */
  names: readonly string[];
  /** The packages importing which means that technology. */
  packages: readonly string[];
}

/**
 * The built-in table. Documented in docs/cli.md ("Technologies and their
 * packages"); keep the two in step.
 */
export const TECHNOLOGY_PACKAGES: readonly TechnologyPackageEntry[] = [
  { names: ['postgres', 'postgresql', 'pg'], packages: ['pg', 'postgres', 'pg-promise', '@neondatabase/serverless', '@vercel/postgres'] },
  { names: ['mysql', 'mariadb'], packages: ['mysql2', 'mysql', 'mariadb'] },
  { names: ['redis', 'valkey'], packages: ['redis', 'ioredis', '@redis/client'] },
  { names: ['mongodb', 'mongo'], packages: ['mongodb', 'mongoose'] },
  { names: ['sqlite', 'sqlite3'], packages: ['better-sqlite3', 'sqlite3', 'sqlite'] },
  { names: ['kafka'], packages: ['kafkajs', 'node-rdkafka'] },
  { names: ['rabbitmq', 'amqp'], packages: ['amqplib', 'amqp-connection-manager'] },
];

/** The fused, lower-case form a technology name is looked up by ("PostgreSQL" and "postgre-sql" alike). */
const lookupKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * technology.packages — the entry's tokens, then the built-in table's packages
 * for its name, then the packages `contributed` lists under its name (what
 * loaded packs contribute, keyed by technology name), lower-cased and
 * de-duplicated in that order. Pure: the contributions are handed in.
 */
export function technologyPackages(tech: Technology, contributed: Readonly<Record<string, readonly string[]>> = {}): string[] {
  const key = lookupKey(technologyName(tech));
  const out = new Set<string>(technologyTokens(tech).map((t) => t.toLowerCase()));
  for (const entry of TECHNOLOGY_PACKAGES) {
    if (entry.names.some((n) => lookupKey(n) === key)) for (const p of entry.packages) out.add(p);
  }
  for (const [name, packages] of Object.entries(contributed)) {
    if (lookupKey(name) === key) for (const p of packages) out.add(p.toLowerCase());
  }
  return [...out];
}
