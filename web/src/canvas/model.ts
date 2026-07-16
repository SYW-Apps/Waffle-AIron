/**
 * Client mirror of the host's CanvasModel (src/core/canvas.ts) — the data
 * contract the shared canvas renderer consumes. Fetched from /web/canvas-model
 * (and, later, streamed as on-demand scope slices over the WS channel). The
 * server remains authoritative; only the fields the renderer reads are modeled.
 */

export interface CanvasComponent {
  id: string;
  name: string;
  description: string;
  subsystem: string;
  componentType: string;
  portalType?: string;
  status?: string;
  public: boolean;
  owner?: string;
  owns: string[];
  dependsOn: string[];
  interfaces: {
    id: string;
    name: string;
    description: string;
    methods: {
      name: string;
      description: string;
      signature: string;
      returns: string;
      params?: { name: string; type: string; optional?: boolean }[];
      guarantees?: string[];
    }[];
  }[];
  narratives: { method: string; steps: CanvasNarrativeStep[] }[];
  intents: { method: string; text: string }[];
}

export interface CanvasNarrativeStep {
  n: number;
  text: string;
  kind: string;
  call?: { component: string; method: string };
  cond?: string;
  onTrue?: number;
  onFalse?: number;
  on?: string;
  cases?: { value: string; step: number }[];
  defaultStep?: number;
  loopKind?: string;
  over?: string;
  end?: number;
  catches?: { error: string; step: number }[];
  fin?: number;
  to?: number;
  outcome?: string;
  err?: string;
}

export interface CanvasType {
  id: string;
  name: string;
  kind: string;
  subsystem?: string;
  fields: { name: string; type: string; optional?: boolean; key?: string; references?: string }[];
  methods: { name: string; signature: string; returns: string; description?: string }[];
  usedBy: { component: string; method: string }[];
  componentClass?: string;
  database?: string;
  table?: string;
  linkedEntity?: string;
}

export interface CanvasModel {
  system: {
    name: string;
    vision?: string;
    targetLanguage?: string;
    databases?: { id: string; name: string; engine: string; description?: string; tables?: string[] }[];
    diagram?: {
      lineStyle?: 'bezier' | 'straight' | 'taxi';
      defaultView?: 'architecture' | 'types' | 'databases';
      showDatabases?: boolean;
    };
  };
  generatedAt: string;
  subsystems: {
    id: string;
    name: string;
    description: string;
    targetLanguage?: string;
    status?: string;
    trustedLinks: { subsystem: string; reason: string }[];
  }[];
  components: CanvasComponent[];
  edges: { from: string; to: string; cross: boolean }[];
  types: CanvasType[];
  typeEdges: { from: string; to: string; field: string; card: '1' | '0..1' | '*' }[];
  dataEdges: { from: string; to: string }[];
  issues: { severity: string; code: string; message: string; specId?: string }[];
}
