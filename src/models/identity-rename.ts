// ---------------------------------------------------------------------------
// identity_rename — what an identity move changes in the names a finding is
// carried or allowed by.
//
// The debt register (rules.conformance.carried) and a spec's lint allows key a
// finding by the spec it is anchored to, the site inside it, and the units it
// covers — exactly the ids a component rename, a method rename or a method
// move exist to rewrite. Left alone, unchanged debt reads as both PAID (the old
// key no longer fires) and NEW (the same finding under the new key): F78. So
// the operations that move an identity describe the move once, here, and the
// register and the allows are rekeyed by the same arithmetic.
//
// Pure: a value and the functions over it. Who reads the register, who writes
// the allows, is the caller's business.
// ---------------------------------------------------------------------------

/** One spec id that changes. `sites`, when given, limits it to the entries anchored at one of those sites. */
export interface SpecIdentityMove {
  from: string;
  to: string;
  /**
   * Only an entry whose site is one of these follows — a method move re-homes
   * the moved methods' findings and leaves every other finding of the source
   * spec where it is.
   */
  sites?: string[];
}

/** One component id that changes, wherever a unit or an edge site names it. */
export interface ComponentIdentityMove {
  from: string;
  to: string;
}

/** One contract method that changes identity: its component, its name, or both. */
export interface MethodIdentityMove {
  component: string;
  method: string;
  toComponent: string;
  toMethod: string;
  /**
   * The specs whose own site names the method — the contracts and
   * implementations it was renamed on. An entry anchored on one of them at
   * `method` follows to `toMethod`.
   */
  specs?: string[];
}

/**
 * An identity move, described for the names findings are keyed by
 * (identity_rename). A component rename moves a component and the specs named
 * after it; a method rename moves a method on the specs that declare it; a
 * method move moves the method to another component and its findings to the
 * receiving specs.
 */
export interface IdentityRename {
  specs?: SpecIdentityMove[];
  components?: ComponentIdentityMove[];
  methods?: MethodIdentityMove[];
}

/** Where a finding is keyed: the spec it is anchored to, the site inside it, and the units it covers (rekeyed_anchor). */
export interface RekeyedAnchor {
  spec: string;
  at?: string;
  covers?: string[];
}

/** The separator an edge site is written with (`from -> to`), as the findings that report one write it. */
const EDGE = ' -> ';

/** A `[<step>:]<component>.<method>` unit: the step prefix, the component, the method. */
const QUALIFIED_UNIT = /^(\d+:)?([^.\s]+)\.([^.\s]+)$/;

/** A component id as this move leaves it. */
function movedComponent(rename: IdentityRename, id: string): string {
  return rename.components?.find((c) => c.from === id)?.to ?? id;
}

/**
 * identity_rename.rekeyUnit — one unit as this move leaves it. A
 * `[<step>:]<component>.<method>` unit (a call claim, a colocated crossing, a
 * declared call) follows a moved method first, else a renamed component; each
 * side of an edge (`a -> b`) follows a renamed component. Anything else — a
 * parameter name, a field, a file path — is no identity a move changes, and is
 * answered unchanged.
 */
export function rekeyUnit(rename: IdentityRename, unit: string): string {
  if (unit.includes(EDGE)) return unit.split(EDGE).map((side) => movedComponent(rename, side)).join(EDGE);
  const qualified = QUALIFIED_UNIT.exec(unit);
  if (!qualified) return unit;
  const [, step = '', component, method] = qualified;
  const moved = rename.methods?.find((m) => m.component === component && m.method === method);
  if (moved) return `${step}${moved.toComponent}.${moved.toMethod}`;
  return `${step}${movedComponent(rename, component)}.${method}`;
}

/**
 * identity_rename.rekeyAnchor — where a finding is keyed once this move is
 * written: its spec follows a moved spec (only for a listed site, when the
 * move lists sites), its site follows a renamed method on the specs that
 * declared it or, for an edge, a renamed component, and every unit it covers
 * follows as rekeyUnit says. Every lookup reads the anchor as it stood, so the
 * three answers never depend on one another.
 */
export function rekeyAnchor(rename: IdentityRename, anchor: RekeyedAnchor): RekeyedAnchor {
  const { spec, at, covers } = anchor;
  const movedSpec = rename.specs?.find((s) => s.from === spec && (!s.sites || (at !== undefined && s.sites.includes(at))));
  let site = at;
  if (at !== undefined) {
    if (at.includes(EDGE)) {
      site = rekeyUnit(rename, at);
    } else {
      const moved = rename.methods?.find((m) => m.method === at && m.specs?.includes(spec));
      if (moved) site = moved.toMethod;
    }
  }
  return {
    spec: movedSpec?.to ?? spec,
    ...(site !== undefined ? { at: site } : {}),
    ...(covers !== undefined ? { covers: covers.map((unit) => rekeyUnit(rename, unit)) } : {}),
  };
}

/**
 * One edit an identity move made to the debt register (carried_rekey): which
 * carried finding, which of its keys, and the value before and after. The
 * finding is named by its code, spec and site as they stood BEFORE the edit,
 * which is how a reader finds it in the diff.
 */
export interface CarriedRekey {
  code: string;
  spec: string;
  at: string;
  /** The key the edit changed: the anchoring spec, the site, or one covered unit. */
  field: 'spec' | 'at' | 'covers';
  from: string;
  to: string;
}
