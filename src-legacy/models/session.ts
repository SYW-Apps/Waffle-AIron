import { z } from 'zod';

// ---------------------------------------------------------------------------
// Session — a persistent, resumable AI working session
//
// Unlike a run step (which is a one-off delegated task), a session is the
// user's own interactive working environment. It persists between invocations:
// the tool's config dir (.claude/ or .gemini/) is kept so conversation history,
// settings, and project context survive across multiple uses.
//
// Sessions live at .wai/sessions/<id>/
//   session.yaml          ← this metadata file
//   .claude/              ← isolated tool config dir (CLAUDE_HOME)
//     CLAUDE.md           ← generated: project context + domain map + guide
//     agents/             ← generated: agent files for this session's scope
//   .gemini/
//     GEMINI.md
//
// "default" session: wairon maintains a per-backend default session. Running
// `wairon session` resumes the default session for the project's defaultBackend.
// ---------------------------------------------------------------------------

export const SessionStatusSchema = z.enum([
  'active',    // currently running (guard against concurrent starts)
  'idle',      // last session ended cleanly
  'crashed',   // process exited non-zero; may need inspection
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: z.string(),

  /** Human-readable label */
  label: z.string().optional(),

  /** Whether this is the default session for its backend (resumed by `wairon session`) */
  isDefault: z.boolean().default(false),

  /** AI backend */
  backend: z.enum(['claude', 'gemini', 'ollama', 'openai', 'custom']),

  /** Domain scope (null = project root) */
  domainId: z.string().nullable().default(null),

  status: SessionStatusSchema.default('idle'),

  /** Number of times this session has been started */
  startCount: z.number().default(0),

  createdAt:    z.string().datetime(),
  lastStartedAt: z.string().datetime().optional(),
  lastEndedAt:  z.string().datetime().optional(),
});
export type Session = z.infer<typeof SessionSchema>;
