import * as fs from 'fs';
import * as path from 'path';
import { aiDir, ensureDir, writeFile, pathExists, fromProjectRoot } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { Session, SessionSchema } from '../models/session.js';

// ---------------------------------------------------------------------------
// Session storage — .wai/sessions/<id>/session.yaml
// ---------------------------------------------------------------------------

export function sessionsDir(): string {
  return aiDir('sessions');
}

export function sessionDir(id: string): string {
  return aiDir('sessions', id);
}

export function sessionMetaPath(id: string): string {
  return path.join(sessionDir(id), 'session.yaml');
}

export function sessionToolConfigDir(id: string, backend: string): string {
  const toolDir = backend === 'gemini' ? '.gemini' : '.claude';
  return path.join(sessionDir(id), toolDir);
}

export function sessionContextFilePath(id: string, backend: string): string {
  const dir      = sessionToolConfigDir(id, backend);
  const filename = backend === 'gemini' ? 'GEMINI.md' : 'CLAUDE.md';
  return path.join(dir, filename);
}

export function sessionAgentsDir(id: string, backend: string): string {
  return path.join(sessionToolConfigDir(id, backend), 'agents');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function loadSession(id: string): Session {
  const raw = readYamlFile(sessionMetaPath(id));
  if (!raw) throw new Error(`Session "${id}" not found.`);
  return SessionSchema.parse(raw);
}

export function saveSession(session: Session): void {
  ensureDir(sessionDir(session.id));
  writeYamlFile(sessionMetaPath(session.id), session);
}

export function listSessions(): Session[] {
  const dir = sessionsDir();
  if (!pathExists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      try { return loadSession(e.name); } catch { return null; }
    })
    .filter((s): s is Session => s !== null)
    .sort((a, b) => (b.lastStartedAt ?? b.createdAt).localeCompare(a.lastStartedAt ?? a.createdAt));
}

export function generateSessionId(backend: string, domainId?: string | null): string {
  const base = domainId ? `${backend}-${domainId}` : backend;
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  const rand = Math.random().toString(36).slice(2, 5);
  return `${safe}-${rand}`;
}

// ---------------------------------------------------------------------------
// Default session resolution
//
// `wairon session` resumes the most-recently-used idle session for the
// requested backend+domain combination, or creates a new one.
// ---------------------------------------------------------------------------

export function findDefaultSession(backend: string, domainId?: string | null): Session | null {
  const sessions = listSessions();
  // Prefer an existing idle session for the same backend + domain
  const match = sessions.find(
    (s) =>
      s.backend  === backend &&
      s.domainId === (domainId ?? null) &&
      s.status   !== 'active',
  );
  return match ?? null;
}

// ---------------------------------------------------------------------------
// Context file generation for a session
//
// Combines: project context + architecture + domain scope + agent roster
// + wairon guide. NOT task-specific — this is ambient context for the session.
// ---------------------------------------------------------------------------

export function buildSessionContextFile(_backend: string, domainId: string | null): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { readProjectContext, readArchitectureContext } = require('./context.js') as typeof import('./context.js');
  const { loadDomainRegistry, loadRegistry, loadProjectConfig } = require('../config/loader.js') as typeof import('../config/loader.js');
  const { GLOBAL_GUIDE_BODY } = require('../utils/ai-guide.js') as typeof import('../utils/ai-guide.js');
  /* eslint-enable @typescript-eslint/no-require-imports */

  let projectName = 'this project';
  try { projectName = loadProjectConfig().name; } catch { /* fallback */ }

  const projectCtx  = readProjectContext();
  const archCtx     = readArchitectureContext();
  const lines: string[] = [];

  // ── 1. Project context ───────────────────────────────────────────────────
  if (projectCtx) {
    lines.push(`# Project: ${projectName}`);
    lines.push('');
    lines.push(projectCtx.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  if (archCtx) {
    lines.push('# Architecture');
    lines.push('');
    lines.push(archCtx.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ── 2. Domain scope ──────────────────────────────────────────────────────
  try {
    const registry = loadDomainRegistry();
    const domains  = registry.domains;

    if (domainId && domainId !== 'root') {
      const domain = domains.find((d) => d.id === domainId);
      if (domain) {
        lines.push(`# Domain Scope: ${domain.name ?? domain.id}`);
        lines.push('');
        lines.push(`This session is scoped to the **${domain.name ?? domain.id}** domain.`);
        lines.push(`- **Path:** \`${domain.path}\``);
        lines.push(`- **Delegate from parent:** \`wairon delegate ${domain.id}\``);
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    } else {
      // Root session — show full domain map
      if (domains.length > 1) {
        lines.push('# Domain Map');
        lines.push('');
        lines.push('| ID | Path | Name |');
        lines.push('|----|------|------|');
        for (const d of domains.filter((d) => d.id !== 'root')) {
          lines.push(`| \`${d.id}\` | \`${d.path}\` | ${d.name ?? d.id} |`);
        }
        lines.push('');
        lines.push('---');
        lines.push('');
      }
    }
  } catch { /* not initialized — skip */ }

  // ── 3. Agent roster ──────────────────────────────────────────────────────
  try {
    const agentRegistry = loadRegistry();
    const agents = domainId && domainId !== 'root'
      ? agentRegistry.agents.filter((a) => a.domainRoot === domainId)
      : agentRegistry.agents;

    if (agents.length > 0) {
      lines.push('# Available Agents');
      lines.push('');
      for (const a of agents) {
        lines.push(`- **${a.id}**${a.domainRoot ? ` *(${a.domainRoot})*` : ''} — ${a.description}`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  } catch { /* skip */ }

  // ── 4. wairon guide ──────────────────────────────────────────────────────
  lines.push(GLOBAL_GUIDE_BODY);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Scaffold a session workspace
// ---------------------------------------------------------------------------

export function scaffoldSession(session: Session): string {
  const { id, backend, domainId } = session;

  const toolConfigDir = sessionToolConfigDir(id, backend);
  const agentsOutDir  = sessionAgentsDir(id, backend);

  ensureDir(toolConfigDir);
  ensureDir(agentsOutDir);

  // Always regenerate the context file (project context may have changed)
  const contextContent = buildSessionContextFile(backend, domainId);
  writeFile(sessionContextFilePath(id, backend), contextContent);

  // Copy agent files for this session's scope
  _copyAgentFiles(id, backend, domainId);

  return toolConfigDir;
}

function _copyAgentFiles(
  sessionId: string,
  backend: string,
  domainId: string | null,
): void {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { loadRegistry, loadProjectConfig, loadDomainRegistry } = require('../config/loader.js') as typeof import('../config/loader.js');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const registry = loadRegistry();
    const config   = loadProjectConfig();
    const domReg   = loadDomainRegistry();
    const cwd      = fromProjectRoot();

    const backendType = backend === 'gemini' ? 'gemini' : 'claude';
    const target = config.targets.find((t) => t.type === backendType);
    if (!target) return;
    const outputDir = 'outputDir' in target ? target.outputDir : (backendType === 'gemini' ? '.gemini/agents' : '.claude/agents');

    const agents = domainId && domainId !== 'root'
      ? registry.agents.filter((a) => a.domainRoot === domainId)
      : registry.agents;

    const destDir = sessionAgentsDir(sessionId, backend);

    for (const agent of agents) {
      let sourceBase = cwd;
      if (agent.domainRoot) {
        const domain = domReg.domains.find((d) => d.id === agent.domainRoot);
        if (domain) sourceBase = path.resolve(cwd, domain.path);
      }
      const srcPath = path.resolve(sourceBase, outputDir, `${agent.id}.md`);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, path.join(destDir, `${agent.id}.md`));
      }
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Environment variables for a session subprocess
// ---------------------------------------------------------------------------

export function sessionEnvVars(sessionId: string, backend: string): Record<string, string> {
  const configDir = path.resolve(sessionToolConfigDir(sessionId, backend));
  const envKey    = backend === 'gemini' ? 'GEMINI_CONFIG_DIR' : 'CLAUDE_HOME';
  return {
    [envKey]:           configDir,
    WAIRON_SESSION_ID:  sessionId,
    WAIRON_SESSION_DIR: path.resolve(sessionDir(sessionId)),
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanSessions(options: { keepRecent?: number; all?: boolean } = {}): number {
  const sessions  = listSessions();
  const keepCount = options.keepRecent ?? 0;
  let removed     = 0;

  const toRemove = options.all
    ? sessions
    : sessions
        .filter((s) => s.status !== 'active')
        .slice(keepCount); // keep the N most recent

  for (const s of toRemove) {
    try {
      fs.rmSync(sessionDir(s.id), { recursive: true, force: true });
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}
