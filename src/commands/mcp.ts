import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig } from '../config/loader.js';
import { aiDir } from '../utils/fs.js';

/** The Claude config dir for global installs — respects CLAUDE_CONFIG_DIR so custom
 *  config-dir setups / account aliases (e.g. `claude-syw`, `claude-work`) work. */
function claudeGlobalDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}

/** The Gemini/Antigravity home dir — respects GEMINI_CONFIG_DIR. */
function geminiGlobalDir(): string {
  return process.env['GEMINI_CONFIG_DIR'] || path.join(os.homedir(), '.gemini');
}

// ---------------------------------------------------------------------------
// wairon mcp serve
// ---------------------------------------------------------------------------

export async function runMcpServe(): Promise<void> {
  // Validate that we're in an initialized project before starting.
  assertProjectInitialized();

  // Dynamic import so the MCP server module is only loaded when this command
  // runs (avoids pulling @modelcontextprotocol/sdk into every command).
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { startMcpServer } = require('../mcp/server.js') as typeof import('../mcp/server.js');
  /* eslint-enable @typescript-eslint/no-require-imports */

  await startMcpServer();
}

// ---------------------------------------------------------------------------
// wairon mcp install  — write MCP server config to the project's .claude/settings.json
// ---------------------------------------------------------------------------

export interface McpInstallOptions {
  backend?: 'claude' | 'gemini';
  global?:  boolean;
}

export async function runMcpInstall(options: McpInstallOptions = {}): Promise<void> {
  assertProjectInitialized();

  let backends: ('claude' | 'gemini')[] = [];
  if (options.backend) {
    backends = [options.backend];
  } else {
    try {
      const config = loadProjectConfig();
      const enabledTypes = config.targets
        .filter((t) => !('enabled' in t) || t.enabled)
        .map((t) => t.type);

      if (enabledTypes.includes('claude')) {
        backends.push('claude');
      }
      if (enabledTypes.includes('gemini') || enabledTypes.includes('agy')) {
        backends.push('gemini');
      }
    } catch {
      // Fallback if config loading fails
    }
    if (backends.length === 0) {
      backends = ['claude']; // Default fallback
    }
  }

  for (const backend of backends) {
    // ── Resolve where to write settings ──────────────────────────────────────
    let configBase: string;
    let settingsPath: string;

    if (backend === 'gemini') {
      if (options.global) {
        // Global install (opt-in): home config + the global Antigravity plugin.
        configBase = path.join(geminiGlobalDir(), 'antigravity-cli');
        settingsPath = path.join(configBase, 'mcp_config.json');
        installGlobalPluginForGemini();
      } else {
        // Project-local Gemini/Antigravity settings — stays within the project.
        configBase = path.join(process.cwd(), '.gemini');
        settingsPath = path.join(configBase, 'settings.json');
      }
    } else {
      // Claude: --global respects CLAUDE_CONFIG_DIR; otherwise project-local.
      configBase = options.global ? claudeGlobalDir() : path.join(process.cwd(), '.claude');
      settingsPath = path.join(configBase, 'settings.json');
    }

    // ── Read existing settings (or start fresh) ───────────────────────────────
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      } catch {
        logger.warn(`Could not parse ${settingsPath} — starting fresh.`);
      }
    }

    // ── Build the mcpServers entry ────────────────────────────────────────────
    const mcpServers = (settings['mcpServers'] ?? {}) as Record<string, unknown>;

    if (mcpServers['wairon']) {
      logger.info(`wairon MCP server is already registered for ${backend === 'gemini' ? 'Antigravity' : 'Claude'} in ${chalk.gray(settingsPath)}.`);
      continue;
    }

    const scriptPath = process.argv[1] ? path.resolve(process.argv[1]).replace(/\\/g, '/') : null;
    const useDirectNode = scriptPath && (scriptPath.endsWith('.js') || scriptPath.endsWith('.ts'));

    mcpServers['wairon'] = useDirectNode
      ? {
          command: 'node',
          args:    [scriptPath, 'mcp', 'serve'],
          env:     {},
        }
      : {
          command: 'wairon',
          args:    ['mcp', 'serve'],
          env:     {},
        };
    settings['mcpServers'] = mcpServers;

    // ── Write back ────────────────────────────────────────────────────────────
    if (!fs.existsSync(configBase)) fs.mkdirSync(configBase, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    logger.success(`wairon MCP server registered for ${backend === 'gemini' ? 'Antigravity' : 'Claude'} in ${chalk.cyan(settingsPath)}.`);
    logger.blank();
    logger.info('AI tools using this config will have access to these wairon tools:');
    logger.info('  listAgents · getAgent · listDomains · validateTopology · getProjectConfig');
    logger.info('  sdd_initialize_system · sdd_add_subsystem · sdd_add_component · sdd_define_interface');
    logger.info('  sdd_write_narrative · sdd_validate_tree · sdd_get_status');
    logger.blank();
    const restartApp = backend === 'gemini' ? 'Antigravity CLI (agy)' : 'claude';
    logger.info(`Restart ${chalk.bold(restartApp)} (or reload MCP servers) to activate.`);
    logger.blank();
  }
}

// ---------------------------------------------------------------------------
// wairon mcp status  — show whether the MCP server is configured
// ---------------------------------------------------------------------------

export async function runMcpStatus(): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const claudeProject = path.join(process.cwd(), '.claude', 'settings.json');
  const claudeGlobal  = path.join(claudeGlobalDir(), 'settings.json');
  const geminiProject = path.join(process.cwd(), '.gemini', 'settings.json');
  const geminiGlobal  = path.join(geminiGlobalDir(), 'antigravity-cli', 'mcp_config.json');

  logger.blank();
  logger.info(`${chalk.bold('wairon MCP Server')}`);
  logger.blank();

  const checks = [
    { label: 'Claude (project)', filePath: claudeProject, fallbackName: 'settings.json' },
    { label: 'Claude (global)', filePath: claudeGlobal, fallbackName: 'settings.json' },
    { label: 'Antigravity (project)', filePath: geminiProject, fallbackName: 'settings.json' },
    { label: 'Antigravity (global)', filePath: geminiGlobal, fallbackName: 'mcp_config.json' },
  ];

  for (const { label, filePath, fallbackName } of checks) {
    if (!fs.existsSync(filePath)) {
      console.log(`  ${label}: ${chalk.gray(`${fallbackName} not found`)}`);
      continue;
    }
    try {
      const s = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const registered = !!(s['mcpServers'] as Record<string, unknown> | undefined)?.['wairon'];
      const mark = registered ? chalk.green('✓ registered') : chalk.gray('not registered');
      console.log(`  ${label}: ${mark}  ${chalk.gray(filePath)}`);
    } catch {
      console.log(`  ${label}: ${chalk.red('parse error')}  ${chalk.gray(filePath)}`);
    }
  }

  logger.blank();
  logger.info(`Project: ${chalk.bold(projectConfig.name)}`);
  logger.blank();
  logger.info(`To register for Claude: ${chalk.bold('wairon mcp install --backend claude')}`);
  logger.info(`To register for Antigravity (agy): ${chalk.bold('wairon mcp install --backend gemini')}`);
  logger.info(`To start manually: ${chalk.bold('wairon mcp serve')}`);
  logger.blank();

  // Also show wai dir location so user knows where context comes from
  const mcpDir = aiDir('mcp');
  if (fs.existsSync(mcpDir)) {
    logger.info(`MCP state dir: ${chalk.gray(mcpDir)}`);
  }
}

function installGlobalPluginForGemini(): void {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const pluginDir = path.join(home, '.gemini', 'config', 'plugins', 'wairon');
  const skillDir = path.join(pluginDir, 'skills', 'wairon');

  try {
    fs.mkdirSync(skillDir, { recursive: true });

    // Write plugin.json
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'wairon' }, null, 2) + '\n',
      'utf8'
    );

    // Write SKILL.md
    const skillContent = `---
name: wairon
description: >
  Guide and orchestrate Spec-Driven Development (SDD) using the Wairon framework.
  Use when designing new system features, modifying software architecture, or managing agent topology.
  Triggers automatically to propose Wairon SDD if a project is not yet initialized but needs design.
---

# Wairon Spec-Driven Development (SDD) Skill

You are equipped with the **Wairon** plugin, which implements Spec-Driven Development (SDD) for building software architectures. You must use this skill to guide the user in designing clean, modular, and verified system specifications before writing any implementation code.

---

## 🚀 Proactive Engagement Rule
If the project does **not** have a \\\`.wai\\\` directory in the root, and the user asks to start a new project, design a system, or write code for a new application:
1. **DO NOT** just start writing code or generating flat folders.
2. **PROPOSE** using Wairon SDD to the user first. Ask them:
   > I notice that this project doesn't have a Wairon Spec-Driven Development (SDD) workspace configured. Would you like to use Wairon SDD to design the system architecture, component contracts, and implementation narratives before writing any code?
3. If the user agrees, proceed to initialize the workspace by asking them to run \\\`wairon init\\\` (or execute it via node locally if authorized, e.g. \\\`node <path-to-wairon-cli> init -y\\\`).

---

## 📐 Spec-Driven Development (SDD) Workflow
Wairon separates system specifications into five distinct levels (L0 to L5) across six design stages. You must guide the user step-by-step through these stages, focusing **subsystem-by-subsystem** to keep review batches small.

### The Six Design Stages
1. **Stage 1 (Context)**: Synthesize requirements into \\\`.wai/context/project.md\\\`. Document the project overview, stack details, and key conventions.
2. **Stage 3–5 (Subsystem-by-Subsystem Focus)**: Proceed through these stages for **one subsystem at a time** before moving to the next:
   - **Stage 2 (L0/L1 System & Subsystems)**: Define the overarching system vision (\\\`.wai/specs/system.yaml\\\`) and subsystems (\\\`.wai/specs/<subsystem>/subsystem.yaml\\\`).
   - **Stage 3 & 4 (L2 Components & L3 Interfaces)**: For the active subsystem, create components (\\\`component.yaml\\\`) and define interface contracts (\\\`interface.yaml\\\`). Request user review/approval.
   - **Stage 5 (L4 Implementations & L5 Narratives)**: Write execution narratives (\\\`implementation.yaml\\\`) for the active subsystem.
3. **Stage 6 (Validation & Sandbox)**: Run validation tools to ensure there are no circular dependencies, stereotype violations, or invalid references.

---

## 👥 Multi-Agent Topology & Task Delegation
Wairon generates a dedicated topology of specialized developer agents (e.g. \`system-architect\`, subsystem owners, and implementers).
- **Mandatory Delegation Rule:** You must NOT perform design updates, write method narratives, or write implementation code directly yourself in the root context.
- **Task Delegation Workflow:**
  - For all design tasks (L0–L3 specs), delegate to the **\`system-architect\`** subagent (or invoke the \`/sdd architect\` skill).
  - For all method narrative tasks (L4–L5 specs), delegate to the **\`sdd-narrative\`** subagent (or invoke the \`/sdd narrative\` skill).
  - For compiling specs into concrete implementation code (Stage 6), spawn the specific **\`<component-id>-implementer\`** subagent using your tool's native subagent mechanism.
  - Always coordinate through the specialized subagents rather than making direct edits in the root session.

---

## 🔒 Crucial Architectural Constraints

1. **Zero Implementation during Design**: Do not write, modify, or generate any source code files (e.g. \\\`.ts\\\`, \\\`.rs\\\`, \\\`.py\\\`) until Stage 6 is reached and the spec tree validates cleanly (\\\`valid: true\\\`).
2. **Tree Structure Isolation**:
   - **L0 System**: Declared ONLY in \\\`.wai/specs/system.yaml\\\`.
   - **L1 Subsystems**: Declared in \\\`.wai/specs/<subsystem>/subsystem.yaml\\\`.
   - **L2 Components**: Declared in \\\`.wai/specs/<subsystem>/<component>/component.yaml\\\`.
   - **L3 Interfaces**: Declared in \\\`.wai/specs/<subsystem>/<component>/interface.yaml\\\`.
   - **L4 Implementations & L5 Narratives**: Declared in \\\`.wai/specs/<subsystem>/<component>/implementation.yaml\\\`.
   *(Note: If legacy flat folders like \\\`.wai/specs/subsystems/\\\` or \\\`.wai/specs/components/\\\` exist and contain files, respect them and continue using the flat structure for backward compatibility. Otherwise, always default to the nested tree structure.)*
3. **Iterative Feedback Loop**:
   - For every subsystem, component, or interface you define: draft the spec file, present the drafted YAML structure/content and a concise summary of key design choices directly in the chat, and ask: *"Does this match your expectations? Is this correct, or is it off-track?"*
   - Do NOT create temporary/intermediate markdown review files in the brain or workspace.
   - Wait for explicit user confirmation before proceeding. Do not work ahead.
4. **Component Stereotypes (Boundaries)**:
   - Building blocks: \\\`Portal\\\` (inbound entrypoint), \\\`Orchestrator\\\` (owns one workflow), \\\`Supervisor\\\` (owns the set of Actors), \\\`Actor\\\` (owns one live process/loop), \\\`Store\\\` (authoritative state), \\\`Index\\\` (read projection over a Store), \\\`Registry\\\` (write path / CUD), \\\`Adapter\\\` (the only external-I/O client — DB/HTTP/bus), \\\`Observer\\\` (subscribes to events), \\\`Specialist\\\` (one focused capability).
   - Patterns (set \\\`owns\\\`): \\\`Repository\\\` (owns Store + Registry + Indexes + optional Adapter) and \\\`Gateway\\\` (Portal + ingress Orchestrator + interceptor Specialists). A pattern owns only building blocks, never another pattern.
   - Dependencies: a Store depends only on a backend Adapter; Registry (write) and Index (read) are decoupled and both work on the Store; any component may depend on an Adapter; Portals/Observers are top-level (never depended upon). Use \\\`owns\\\` for a pattern's private members and \\\`dependsOn\\\` for collaborators.

---

## 🛠️ CLI Command Reference
When executing Wairon commands or instructing the user, use the appropriate command string. (If running locally via node, use \\\`node <path_to_dist_cli> <command>\\\`):
- **Initialize**: \\\`wairon init\\\` (or \\\`node .../dist/cli/index.js init\\\`)
- **Validate Spec Tree**: \\\`wairon validate\\\` (or \\\`node .../dist/cli/index.js validate\\\`)
- **Show Status Dashboard**: \\\`wairon status\\\` (or \\\`node .../dist/cli/index.js status\\\`)
- **Generate Agent Files**: \\\`wairon generate\\\` (or \\\`node .../dist/cli/index.js generate\\\`)
- **Register MCP Server**: \\\`wairon mcp install\\\` (or \\\`node .../dist/cli/index.js mcp install\\\`)

---

## 🔌 MCP Tools Integration
If the \\\`wairon\\\` MCP server is registered, you can use these tools directly:
- \\\`sdd_initialize_system\\\`: Initialize L0 System Spec.
- \\\`sdd_add_subsystem\\\`: Add L1 Subsystem Spec.
- \\\`sdd_add_component\\\`: Add L2 Component Spec (default to \\\`status: draft\\\` during design).
- \\\`sdd_define_interface\\\`: Define L3 Interface signatures.
- \\\`sdd_write_narrative\\\`: Write L4/L5 execution narratives and source paths.
- \\\`sdd_validate_tree\\\`: Validate entire tree for schema correctness, dependencies, and boundaries.
- \\\`sdd_get_status\\\`: View status dashboard of spec completeness.
- \\\`listAgents\\\`, \\\`getAgent\\\`, \\\`listDomains\\\`, \\\`validateTopology\\\`, \\\`getProjectConfig\\\`: Manage multi-agent topology and configurations.

---

## 📜 Core Architecture & Coding Standards
This project requires strict adherence to the **Core Standards & Principles** inlined below. These rules are binding on all development activities (do NOT read these standards from disk; they are already fully specified in your system context):
1. **Semantic Naming & Stereotypes**:
   - Never use generic names like "Manager", "Helper", or "Utils".
   - Use exact component roles: \`Portal\` (external entrypoints), \`Orchestrator\` (business workflow coordination), \`Supervisor\` (overseeing processes), \`Store\` (authoritative state/data), \`Registry\` (registrations), \`Index\` (read paths), \`Actor\` (asynchronous work), \`Observer\` (state monitoring), and \`Specialist\` (specialized logic like Scanners, Routers, Evaluators, Compilers).
2. **Narrative Coding**:
   - Every function body must read top-to-bottom as a sequential list of named, readable steps (Narrative Composition).
   - Maintain one level of abstraction per function. Functions must remain short (~25 lines max).
   - Prefer extracting clear private helper methods over writing inline comments.
3. **Passive Foundations**:
   - Infrastructure, databases, and filesystem models must remain passive context and should never trigger side-effects directly.
4. **Zero-Copy Purity & Zero-Wait Concurrency (Write-Lock / Read-Swap Hybrid)**:
   - Use shared data models directly (passing pointers/references directly without serialization or cloning).
   - For shared mutable state, use wait-free/lock-free reads (e.g. via atomic pointer swaps or copy-on-write pointers) and serialize updates via a standard mutex (preventing CPU thrashing/starvation of raw CAS loops).
   - For Actors, expose state to readers via atomic snapshot hotswaps without locks.

---

## 📋 Spec File YAML Schemas
You must strictly construct YAML spec files according to these exact schemas:

### 1. Level 0: System (\`system.yaml\` in \`.wai/specs/\`)
\`\`\`yaml
schemaVersion: "1.0.0"
name: "system-name"
vision: "High-level vision of the system..."
boundaries:
  - name: "Boundary Name"
    description: "Scope details..."
globalRequirements:
  - description: "Must support high-throughput metering..."
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
\`\`\`

### 2. Level 1: Subsystem (\`subsystem.yaml\` under \`.wai/specs/<subsystem>/\`)
\`\`\`yaml
id: "billing" # lowercase-alphanumeric-dashes
name: "Billing Subsystem"
description: "Handles subscriptions and invoicing..."
parentSystem: "system-name"
publicInterfaces:
  - type: "REST" # REST | GraphQL | MessageBus | RPC | Custom
    details: "/api/v1/billing endpoint"
status: "complete" # draft | design | complete
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
\`\`\`

### 3. Level 2: Component (\`component.yaml\` under \`.wai/specs/<subsystem>/<component>/\`)
\`\`\`yaml
id: "billing-store" # lowercase-alphanumeric-dashes
name: "Billing Store"
description: "Authoritative state storage for billing data"
subsystem: "billing" # references L1 Subsystem ID
componentType: "Store" # Blocks: Portal|Orchestrator|Supervisor|Actor|Store|Index|Registry|Adapter|Observer|Specialist — Patterns: Repository|Gateway
owns: [] # member block ids (Repository/Gateway patterns only)
dependsOn:
  - "database-adapter" # other L2 component ids this collaborates with
status: "draft" # draft | design | complete
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
\`\`\`

### 4. Level 3: Interface (\`interface.yaml\` under \`.wai/specs/<subsystem>/<component>/\`)
\`\`\`yaml
id: "ibilling-store" # prefixed with a lowercase "i"
name: "Billing Store Interface"
description: "Read/write contract for billing data"
component: "billing-store" # references L2 Component ID
methods:
  - name: "save_invoice" # alphanumeric-underscores
    description: "Saves a generated invoice to the store"
    signature: "save_invoice(invoice: Invoice): Promise<void>"
    returns: "Promise<void>"
    httpEndpoint: # optional
      method: "POST"
      path: "/invoices"
status: "draft" # draft | design | complete
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
\`\`\`

### 5. Level 4 & 5: Implementation & Narrative (\`implementation.yaml\` under \dots \`.wai/specs/<subsystem>/<component>/\`)
\`\`\`yaml
id: "billing-store-impl"
name: "Billing Store Implementation"
description: "Memory-based billing store with VFS sync"
contract: "ibilling-store" # references L3 Interface ID
sourcePath: "src/billing/store.ts" # optional path to source code
methods:
  - name: "save_invoice" # matches L3 method name
    narrative: # L5 Narrative sequence
      - stepNumber: 1
        description: "Validate the invoice schema matches specifications"
        type: "local" # local | call
      - stepNumber: 2
        description: "Write invoice data to active memory storage"
        type: "local"
      - stepNumber: 3
        description: "Sync the change to the disk registry via VFS"
        type: "call"
        targetComponent: "vfs-registry" # required for 'call'
        targetMethod: "write_file"      # required for 'call'
status: "draft" # draft | design | complete
createdAt: "2026-06-12T20:00:00Z"
updatedAt: "2026-06-12T20:00:00Z"
\`\`\`
`;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf8');
    logger.success(`wairon global Antigravity plugin installed at ${chalk.cyan(pluginDir)}.`);
  } catch (e) {
    logger.warn(`Could not install wairon global Antigravity plugin: ${String(e)}`);
  }
}
