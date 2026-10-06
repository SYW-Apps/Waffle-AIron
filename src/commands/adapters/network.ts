// ---------------------------------------------------------------------------
// cli_network_adapter — sdd_cli's client hop into sdd_network: identity
// re-exports of the network portal, backing `wairon network`.
// ---------------------------------------------------------------------------
export { flows, policy, diagram, check, why } from '../../network/index.js';
export type { FlowCheckReport, FlowExplanation, NetworkDocument, NetworkFlow, NetworkOutputFormat, ObservedFlow } from '../../network/index.js';
