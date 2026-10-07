// ---------------------------------------------------------------------------
// network_orchestrator — the derived networking workflows. Each reads the
// reach model through the validator adapter, derives the flow matrix, and
// then encodes it, draws it, checks observed flows against it, or explains one
// flow. Each reads the bindings or observed-flow file through the file adapter
// when its output needs deployment facts. It holds no state and writes
// nothing: every output is answered for its caller to print or save.
// ---------------------------------------------------------------------------

import type { ValidationOptions } from '../core/validation.js';
import { reachModel } from './adapters/validator.js';
import { readBindings, readObservedFlows } from './adapters/files.js';
import { explain, project } from './flow-matrix.js';
import { encodeFlows, encodePolicy } from './codec.js';
import { mermaid, view as projectView } from './diagram.js';
import { check as checkFlows } from './flow-check.js';
import type { FlowCheckReport, FlowExplanation, NetworkBindings, NetworkDocument, NetworkOutputFormat, NetworkViewModel } from './types.js';

/** inetwork_orchestrator.flows — the allowed-flows matrix, encoded as JSON, CSV or Markdown. */
export function flows(options: ValidationOptions, format: NetworkOutputFormat): NetworkDocument {
  const model = reachModel(options); // Step 1
  const matrix = project(model); // Step 2
  return encodeFlows(matrix, format); // Steps 3-4
}

/** inetwork_orchestrator.policy — generated network policy from the matrix and the team's bindings file. */
export function policy(options: ValidationOptions, bindingsPath: string, format: NetworkOutputFormat): NetworkDocument {
  const bindings = readBindings(bindingsPath); // Step 1: refuse a malformed file before any derivation
  const model = reachModel(options); // Step 2
  const matrix = project(model); // Step 3
  return encodePolicy(matrix, bindings, format); // Steps 4-5
}

/** inetwork_orchestrator.diagram — the network picture as Mermaid. */
export function diagram(options: ValidationOptions): NetworkDocument {
  const model = reachModel(options); // Step 1
  const matrix = project(model); // Step 2
  const picture = projectView(model, matrix); // Step 3
  return mermaid(picture); // Steps 4-5
}

/** inetwork_orchestrator.view — the network picture as the hosted canvas's view model. */
export function view(options: ValidationOptions): NetworkViewModel {
  const model = reachModel(options); // Step 1
  const matrix = project(model); // Step 2
  return projectView(model, matrix); // Steps 3-4
}

/** inetwork_orchestrator.check — observed live flows judged against the matrix. */
export function check(options: ValidationOptions, observedPath: string, bindingsPath: string | null): FlowCheckReport {
  const observed = readObservedFlows(observedPath); // Step 1: refuse a malformed row before any derivation
  // Steps 2-3: the bindings, only when the observed names follow them.
  let bindings: NetworkBindings | null = null;
  if (bindingsPath) bindings = readBindings(bindingsPath);
  const model = reachModel(options); // Step 4: judged, its gate findings ride on it
  const matrix = project(model); // Step 5: each flow marked with the findings on it
  return checkFlows(matrix, observed, bindings, model); // Steps 6-7
}

/** inetwork_orchestrator.why — why one party may reach another, from the design. */
export function why(options: ValidationOptions, from: string, to: string): FlowExplanation {
  const model = reachModel(options); // Step 1: judged, its gate findings ride on it
  const matrix = project(model); // Step 2: each flow marked with the findings on it
  return explain(matrix, from, to, model); // Steps 3-4
}
