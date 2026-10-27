import type { AnalysisGradeLabel } from './lock.js';
import type { CodeModel } from './code-model.js';

/** How a lookup knows a match or a reference, strongest first. */
export type LookupEvidence = 'id' | 'declared' | 'resolved' | 'syntactic' | 'text' | 'unresolved';

/** What kind of design or code element a lookup match names. */
export type LookupElementKind =
  | 'project' | 'subsystem' | 'component' | 'interface' | 'implementation'
  | 'method' | 'type' | 'field' | 'group' | 'endpoint' | 'file';

/** Where a matched spec stands against the project's approval record. */
export type LookupApproval = 'approved' | 'changed' | 'added' | 'unlocked' | 'not-applicable';

/** What shape a reference to an element takes. */
export type LookupReferenceKind =
  | 'depends-on' | 'call-step' | 'type-position' | 'export-use' | 'code-call' | 'import' | 'mention';

/** Whether the design and the code agree on one reference. */
export type LookupAgreement = 'confirmed' | 'declared-only' | 'observed-only' | 'unjudged';

/** Which declared exception covers an element. */
export type LookupWaiverKind = 'unclaimed' | 'carried' | 'lint-allow';

/** How far a change to an element reaches. */
export type LookupImpact = 'none' | 'component' | 'subsystem' | 'project' | 'family' | 'public';

/** Where an element sits in the design: from the project down to the spec that holds it. */
export interface LookupPlace {
  /** The project's id; this project's own for a part's element. */
  project: string;
  /** The member alias the element lives under. */
  member?: string;
  subsystem?: string;
  component?: string;
  /** The contract, implementation, type or group holding a method, field or type. */
  container?: string;
}

/** One element a lookup found, with what it rests on and where to go next. */
export interface LookupMatch {
  /** The exact id: a spec id, owner.member, portal.verb, or a project-relative file path. */
  id: string;
  kind: LookupElementKind;
  name: string;
  place: LookupPlace;
  evidence: LookupEvidence;
  /** What in the element matched the query. */
  matchedOn: string;
  approval: LookupApproval;
  sourcePath?: string;
  /** The named sourcePath does not exist yet. */
  planned: boolean;
  /** The component whose implementer brief covers the element. */
  briefId?: string;
}

/** What a lookup read and what it did not. */
export interface LookupSnapshot {
  /** A fingerprint of the walked source files (path, size, modification time), not a content hash. */
  codeFingerprint: string;
  /** The weakest grade any walked file was read at; none when no code was walked. */
  codeGrade: AnalysisGradeLabel;
  /** When the code model read was built (ISO 8601). */
  builtAt: string;
  searched: string[];
  notSearched: string[];
}

/** The ranked answer to a spec search. */
export interface LookupSearchResult {
  /** At most the asked limit. */
  matches: LookupMatch[];
  /** Every match found before the limit cut the list. */
  total: number;
  snapshot: LookupSnapshot;
}

/** One place that refers to the looked-up element. */
export interface LookupReference {
  kind: LookupReferenceKind;
  evidence: LookupEvidence;
  agreement: LookupAgreement;
  /** The spec that refers, for a design reference or a code reference inside a realized file. */
  fromSpec?: string;
  /** The method or field within fromSpec. */
  fromMember?: string;
  file?: string;
  /** Present where the analysis records one. */
  line?: number;
  /** Where the referring element sits, which the impact is judged from. */
  place: LookupPlace;
  inTest: boolean;
  /** The reference names the element's id; false for a bare-name mention. */
  linked: boolean;
}

/** A declared exception that covers the looked-up element. */
export interface LookupWaiver {
  kind: LookupWaiverKind;
  /** The file, finding code or site it covers. */
  subject: string;
  reason: string;
}

/** Everything that refers to one element, with the waivers that cover it and how far a change reaches. */
export interface LookupReferencesResult {
  target: LookupMatch | null;
  candidates: LookupMatch[];
  references: LookupReference[];
  waivers: LookupWaiver[];
  impact: LookupImpact;
  snapshot: LookupSnapshot;
}

/** One code model cache entry: the model and the source fingerprint it was built from. */
export interface CachedCodeModel {
  fingerprint: string;
  model: CodeModel;
  /** ISO 8601. */
  builtAt: string;
}
