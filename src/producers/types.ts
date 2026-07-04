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
