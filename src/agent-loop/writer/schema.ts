// ---------------------------------------------------------------------------
// Writer Agent — schema and interface definitions
//
// STATUS: STUB — not yet implemented. See docs/vision.md.
//
// The Writer Agent is a specialized, isolated component responsible for all
// file write operations in the agentic loop. It runs as a separate AI call
// (optionally using a different model, e.g. a local Ollama model), keeping
// the main agent's context clean.
//
// Design principles:
//   - Reliability over speed. Redundant validation is intentional.
//   - Pre-write + post-write validation. Neither alone is enough.
//   - Atomic writes: temp-file-then-swap prevents partial corruption.
//   - Structured rejection: the Writer always explains WHY it rejected a change.
//   - Context isolation: the main agent never sees raw file contents or diffs.
//     It only sees the small WriteResult — success summary or rejection reason.
//   - Local-model friendly: the Writer's system prompt is almost entirely rules,
//     not reasoning. A small, fast instruction-following model (e.g. Ollama)
//     is well-suited. Offloads validation overhead to local hardware.
//
// The main agentic loop calls the Writer like any other tool:
//   write_file(path, changeDescription)  → WriteResult
// The Writer handles all the complexity internally.
// ---------------------------------------------------------------------------

export interface WriteRequest {
  /** Absolute path to the file to write or modify */
  targetPath: string;

  /**
   * The intended change, expressed as a description + diff or full content.
   * The Writer validates this before applying.
   */
  change: WriteChange;

  /** Paths the calling agent is allowed to write to (scope enforcement) */
  allowedPaths: string[];
}

export type WriteChange =
  | { type: 'full'; content: string }           // replace entire file
  | { type: 'diff'; diff: string }              // unified diff format
  | { type: 'instruction'; description: string }; // natural language — Writer decides how to apply

export type WriteResultStatus = 'applied' | 'rejected' | 'error';

export interface WriteResult {
  status: WriteResultStatus;

  /**
   * Brief summary of what was done (on success) or why it was rejected.
   * This is what surfaces to the main agent — keep it small.
   */
  summary: string;

  /**
   * Populated on rejection: what the Writer thinks is wrong and likely
   * needs attention before retrying.
   */
  rejectionDetail?: RejectionDetail;
}

export interface RejectionDetail {
  phase: 'pre-validate' | 'apply' | 'post-validate' | 'scope-check';
  reason: string;
  /** Specific location in the file if applicable */
  location?: string;
  /** What the Writer suggests the invoking agent should do */
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Validation pipeline
//
// Each stage can independently reject the write. Stages run in order.
// A rejection at any stage prevents the write from proceeding.
// ---------------------------------------------------------------------------

export interface ValidationStage {
  name: string;
  run(request: WriteRequest, currentContent: string | null): ValidationStageResult;
}

export interface ValidationStageResult {
  passed: boolean;
  detail?: string;
}

// Built-in validation stages (implemented in Phase 4):
//
// 1. ScopeCheck       — is targetPath within allowedPaths?
// 2. SyntaxPreCheck   — does the proposed change parse as valid syntax for the file type?
// 3. DiffSanityCheck  — does the diff apply cleanly without conflicts?
// 4. ApplyChange      — actually write (to temp file)
// 5. SyntaxPostCheck  — does the written file parse without errors?
// 6. ContentVerify    — does the written content contain the expected change?
//                       (re-read and confirm — not just "write succeeded")
