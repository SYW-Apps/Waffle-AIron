// ---------------------------------------------------------------------------
// AIBackend — abstraction over different AI model providers
//
// STATUS: STUB — not yet implemented. See docs/vision.md and docs/roadmap.md.
//
// Phase 3 (chat-only): implement OpenAICompatBackend for direct API calls
// Phase 4 (agentic):   implement AgentLoop + WriterAgent for full file access
//
// All AI calls in the delegate and agentic loop systems will go through this
// interface, keeping provider-specific logic isolated in each backend.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ChatOptions {
  model?: string;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * AIBackend interface
 *
 * Implementations:
 * - SpawnBackend       → shells out to claude/gemini CLI (Phase 2, via delegate command)
 * - OpenAICompatBackend → direct REST API calls to OpenAI-compatible endpoints,
 *                         covers: OpenAI, Ollama, LM Studio, LocalAI, custom URLs
 * - ClaudeAPIBackend   → Anthropic SDK (future, for programmatic Claude access)
 */
export interface AIBackend {
  readonly name: string;

  /**
   * Send a single chat message and return the response.
   * May involve multiple internal turns if tools are active (agentic loop).
   */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;

  /**
   * Check whether the backend is reachable and configured.
   */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Backend configuration — stored per domain or globally in project config
// ---------------------------------------------------------------------------

export interface BackendConfig {
  type: 'claude' | 'gemini' | 'openai' | 'ollama' | 'custom';

  /** For ollama / custom: base URL of the API */
  baseUrl?: string;

  /** Model name, e.g. "codellama:13b" or "gpt-4o" */
  model?: string;

  /** API key for cloud providers (prefer env var over hardcoding) */
  apiKeyEnvVar?: string;
}
