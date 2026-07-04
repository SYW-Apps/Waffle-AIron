// ---------------------------------------------------------------------------
// Producer value types (sdd_producers)
// ---------------------------------------------------------------------------

/** A project's config for one producer target (persisted in .wai/producers.json). */
export interface ProducerConfig {
  target: string;
  parentPageId: string;
}

/** A target-agnostic documentation node: a titled page with a markdown-ish body
 *  and nested child pages, mirroring the spec tree. Each producer renders it. */
export interface DocPage {
  title: string;
  body: string;
  children: DocPage[];
}

/** A component node in the architecture graph (the visual projection). */
export interface GraphNode {
  id: string;
  label: string;
  subsystem: string;
  componentType: string;
}

/** A directed dependency between component nodes. */
export interface GraphEdge {
  from: string;
  to: string;
}

/** The architecture as a node/edge graph — what a visual producer (Miro) renders,
 *  parallel to DocPage for a documentation producer (Notion). */
export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
