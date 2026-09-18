import { SddRule } from '../types.js';
import { methodTypeRefs, type InterfaceSpec, type MethodSignature } from '../../../models/index.js';

/**
 * Builtins that clearly belong to ONE language family. When a subsystem
 * declares a targetLanguage, using another family's marker in a contract is
 * flagged (LANGUAGE_FOREIGN_BUILTIN) — e.g. `usize` in a TypeScript system.
 * Conservative on purpose: only unambiguous markers, no shared vocabulary.
 */
const LANGUAGE_MARKERS: Record<string, ReadonlySet<string>> = {
  rust: new Set([
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'f32', 'f64', 'vec', 'box', 'arc', 'rc', 'refcell', 'cell', 'mutex', 'rwlock', 'str',
  ]),
  typescript: new Set(['any', 'unknown', 'never', 'undefined', 'promise', 'record']),
  javascript: new Set(['promise', 'undefined']),
  python: new Set(['dict', 'tuple']),
  csharp: new Set(['task']),
  go: new Set(['chan', 'rune']),
};

/** One type reference of one contract method, with the language vocabulary judging it. */
interface ReferenceScan {
  intf: InterfaceSpec;
  method: MethodSignature;
  ref: string;
  lang: string;
  ownMarkers: ReadonlySet<string>;
  draft: boolean;
}

/**
 * Language-aware contract hygiene: when a system/subsystem declares a
 * targetLanguage, builtins that unambiguously belong to a DIFFERENT language
 * family are flagged in interface signatures — e.g. `usize`/`Vec` in a
 * TypeScript system, or `Promise`/`any` in a Rust one. Conservative by design:
 * only unambiguous per-language markers trigger, shared vocabulary never does.
 * What a NARRATIVE may say in that language is narrative-language-constructs'
 * question.
 */
export const signatureLanguageBuiltinsRule: SddRule = {
  name: 'signature-language-builtins',
  description:
    'Contracts must speak the declared target language: builtin types that unambiguously belong to another language family are flagged in method signatures (e.g. `usize` in a TypeScript system, `Promise` in a Rust one). Set targetLanguage on the system (L0) or override per subsystem (L1).',
  codes: [
    { code: 'LANGUAGE_FOREIGN_BUILTIN', defaultSeverity: 'warning', summary: 'Signature uses a builtin from a different language family' },
  ],
  check(ctx) {
    // Effective per-language tables: built-ins merged with extension-pack
    // languages (packs may add whole platforms, e.g. "make", or extend a
    // built-in language's tables).
    const markersFor = (family: string): ReadonlySet<string> | undefined => {
      const base = LANGUAGE_MARKERS[family];
      const extra = ctx.ext.languages[family]?.foreignBuiltins;
      if (!extra?.length) return base;
      return new Set([...(base ?? []), ...extra.map(s => s.toLowerCase())]);
    };
    const families = [...new Set([...Object.keys(LANGUAGE_MARKERS), ...Object.keys(ctx.ext.languages)])];

    // Every type reference a declared target language can actually judge. An
    // interface whose subsystem declares none, or whose language has no
    // builtin vocabulary of its own (unknown, or a pack platform that declared
    // none), could legitimately share any builtin — nothing to check against.
    const scans: ReferenceScan[] = [];
    for (const intf of ctx.interfaces) {
      const comp = ctx.componentMap.get(intf.component);
      const lang = ctx.targetLanguageFor(comp?.subsystem);
      if (!lang) continue;
      const ownMarkers = markersFor(lang);
      if (!ownMarkers || ownMarkers.size === 0) continue;
      const draft = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
      for (const method of intf.methods) {
        for (const ref of methodTypeRefs(method)) scans.push({ intf, method, ref, lang, ownMarkers, draft });
      }
    }

    for (const scan of scans) {
      const refLower = scan.ref.toLowerCase();
      if (scan.ownMarkers.has(refLower)) continue;
      const foreign = families.find(family => family !== scan.lang && markersFor(family)?.has(refLower));
      if (!foreign) continue;
      ctx.addIssue(
        'warning',
        'LANGUAGE_FOREIGN_BUILTIN',
        `Method "${scan.method.name}" on interface "${scan.intf.id}" uses "${scan.ref}", a ${foreign} builtin, but the target language here is ${scan.lang}. Use the ${scan.lang} equivalent so implementers generate idiomatic code.`,
        scan.intf.id,
        scan.draft,
      );
    }
  },
};
