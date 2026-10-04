// ---------------------------------------------------------------------------
// The design export's format types (`design_*`, owned by sdd_surfaces).
//
// The design export is one JSON document per project holding the whole design,
// resolved (docs/design/generic-design-model/stage-4-5-export.md). Its zod
// schemas live here; the JSON Schema shipped with the package is generated
// from them.
// ---------------------------------------------------------------------------

import { z } from 'zod';

/**
 * design_approval — the approval state a design export is stamped with: the
 * lock-check verdict the caller decided against the gate identity, handed down
 * from the CLI to the exporter, or `unjudged` when no verdict was handed in
 * (an in-process caller that did not obtain one), which claims nothing either
 * way. Declared order is the spec's.
 */
export const DESIGN_APPROVALS = ['locked', 'stale', 'unlocked', 'unjudged'] as const;
export const DesignApprovalSchema = z.enum(DESIGN_APPROVALS);
export type DesignApproval = z.infer<typeof DesignApprovalSchema>;
