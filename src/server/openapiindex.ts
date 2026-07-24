// ---------------------------------------------------------------------------
// OpenAPI spec INDEX wire shape + its single builder (sdd_host).
//
// When a project publishes SEVERAL public portals and none is selected, the
// server serves a LISTING of the available per-portal APIs in place of an
// OpenAPI document — NEVER a merge of their documents, and never an empty
// document standing in for them. That listing is the `openapi_spec_index`
// value-object: it is carried INSIDE the existing string artifact body
// (share_artifact_result.content, or the surface artifact body), discriminated
// by openapiIndex=true; the string type is unchanged either way.
//
// This is a neutral, component-free helper (like errors.ts / httpio.ts): both
// the surface-exchange orchestrator (landscape.ts) and the share-snapshot
// specialist (sharesnapshots.ts) build the SAME shape, so it is constructed in
// exactly ONE place here rather than reconstructed inline in each. The share
// portal (sharehttp.ts) and web explorer (web.ts) parse/render this same shape;
// they stay decoupled by parsing it structurally rather than importing.
// ---------------------------------------------------------------------------

/**
 * One entry in an openapi_spec_index: a reference to a single per-portal API by
 * portal id + display name — a pointer used to fetch that one API's document
 * (e.g. via ?spec=<portalId>), never the document itself. (Value-object
 * openapi_spec_ref.)
 */
export interface OpenApiSpecRef {
  portalId: string;
  name: string;
}

/**
 * The payload served in place of an OpenAPI document when several per-portal
 * APIs exist and none is selected: a machine-readable listing of them so a
 * consumer picks one. Discriminated by openapiIndex=true. (Value-object
 * openapi_spec_index.)
 */
export interface OpenApiSpecIndex {
  openapiIndex: true;
  specs: OpenApiSpecRef[];
}

/**
 * Build the openapi_spec_index object from the rendered per-portal specs,
 * keeping only the reference fields (portalId + name) — never the documents.
 */
export function buildOpenApiSpecIndex(specs: ReadonlyArray<OpenApiSpecRef>): OpenApiSpecIndex {
  return { openapiIndex: true, specs: specs.map((s) => ({ portalId: s.portalId, name: s.name })) };
}

/**
 * Serialize the openapi_spec_index to the pretty-printed JSON document carried
 * in a string artifact body. The single site the index document is constructed.
 */
export function openApiIndexDocument(specs: ReadonlyArray<OpenApiSpecRef>): string {
  return JSON.stringify(buildOpenApiSpecIndex(specs), null, 2);
}
