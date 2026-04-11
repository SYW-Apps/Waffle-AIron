// ---------------------------------------------------------------------------
// AgentLoop — the core agentic turn cycle for local/custom AI models
//
// STATUS: STUB — not yet implemented. See docs/vision.md and docs/roadmap.md.
// Phase 4 goal.
//
// The AgentLoop enables any OpenAI-compatible model (Ollama, LM Studio,
// custom endpoints) to act as a coding agent with the same file access
// capabilities as Claude Code or Gemini CLI.
//
// Architecture:
//
//   AgentLoop
//     ├── AIBackend          ← model provider (Ollama, OpenAI, etc.)
//     ├── ToolRegistry       ← available tools (read, write, shell, search...)
//     │     └── write_file   ← delegates to WriterAgent, never writes directly
//     └── ContextManager     ← handles context window limits gracefully
//
// Turn cycle:
//   1. Construct messages: system prompt + conversation history + current task
//   2. Call AIBackend.chat() with available tools
//   3. If response contains tool calls → execute via ToolRegistry
//      - write_file calls go through WriterAgent (isolated, validated)
//      - other tools execute directly
//   4. Append tool results to conversation
//   5. Repeat from step 2 until model gives a final text response
//   6. Return final response
//
// All file writes go through WriterAgent — the loop itself never writes files.
// This gives the reliability guarantees documented in writer/schema.ts
// without adding complexity to the turn loop.
//
// Why this matters:
//   Main agent context stays clean. The write validation loop runs inside
//   WriterAgent, optionally via a local Ollama model. Validation overhead
//   is local hardware, not cloud tokens. Main agent only sees:
//     { status: "applied", summary: "fixed line 45" }
//   or:
//     { status: "rejected", reason: "syntax error at line 47 after applying diff" }
// ---------------------------------------------------------------------------

export interface AgentLoopOptions {
  /** Maximum number of agentic turns before giving up */
  maxTurns?: number;
  /** Working directory for shell commands */
  cwd?: string;
  /** Allowed paths for file writes (scope enforcement via WriterAgent) */
  allowedWritePaths?: string[];
}

export interface AgentLoopResult {
  finalResponse: string;
  turns: number;
  toolCallCount: number;
}

// Placeholder — implementation in Phase 4
export async function runAgentLoop(
  _task: string,
  _options: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  throw new Error(
    'AgentLoop is not yet implemented. See docs/roadmap.md Phase 4.\n' +
    'For now, use `wairon delegate` to spawn claude or gemini directly.',
  );
}
