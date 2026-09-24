/**
 * Param conformance (code↔spec for the SIGNATURE) — src/core/rules/conformance/param-conformance.ts.
 *
 * Documented intents pinned here (rule description + module doc comment):
 *  - UNREALIZED_PARAM (warning): a contract declares a parameter the function
 *    realizing the method does not take — an argument the contract promises
 *    that would go nowhere, which every brief and every caller built from the
 *    contract passes.
 *  - UNDECLARED_PARAM (warning): the realizing function takes a parameter no
 *    contract parameter names and no declared injection accounts for — the
 *    shape that hides a credential in a signature nobody has read against its
 *    contract.
 *  - PARAM_NAME_MISMATCH (warning): the two agree on position and type but not
 *    on name. The type agreeing is what makes it a rename rather than a
 *    different argument, and a rename is worth saying because the contract, the
 *    ERD and every brief carry one word while the code answers to another.
 *  - PARAM_OPTIONALITY (warning): the two disagree about whether an argument
 *    may be left out, which is one of them telling a caller an argument is
 *    required when it is not, or the reverse.
 *
 * The quiet shapes, each with a control that is ONE edit away from firing:
 *  - WIRING IS DECLARED, NEVER INFERRED: the leading run an implementation
 *    names in `injectedParams` is dropped, and only that run — the same file
 *    with one name missing from the list reports the parameter it no longer
 *    accounts for (the two trees below differ in nothing else), and a name
 *    from the list appearing AFTER the contract's own parameters is an
 *    argument in the middle of the caller's list rather than wiring;
 *  - a name that differs is reported only where the DECLARED TYPE agrees:
 *    where the code annotates nothing, nothing is said about the name, because
 *    a rename cannot be told from a substitution without it;
 *  - a default value and a rest parameter make an argument omittable exactly
 *    as a question mark does — what a caller may leave out is the thing the
 *    contract is describing;
 *  - an OVERLOADED function answers with the signature that has a BODY, the
 *    one a caller actually reaches, and never with an overload signature;
 *  - a name carrying SEVERAL BODIES — a class member and the module-level
 *    facade that forwards to it — is judged on what they ALL agree on, because
 *    which one the contract means is not something this reader can decide: the
 *    two trees below are the same shape, and differ only in whether both
 *    bodies take the argument the contract never named;
 *  - a file that only forwards the function holds no signature to read: that
 *    the body is not here is `methodRealization`'s finding, and a second voice
 *    would make one absence look like two.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

/** One parameter of the contract under test, in the spelling an L3 method declares it. */
interface ContractParam {
  name: string;
  type: string;
  optional?: boolean;
}

const CONNECTION: ContractParam = { name: 'connectionId', type: 'string' };
const VOLUME: ContractParam = { name: 'kilolitres', type: 'number' };
const BAND: ContractParam = { name: 'tariffBand', type: 'string' };

/** The two-parameter contract most trees below are read against. */
const METERED_VOLUME: ContractParam[] = [CONNECTION, VOLUME];

/**
 * One miniature billing system whose whole subject is ONE signature: the
 * consumption rater's contract parameters, the file realizing them, and the
 * leading run the implementation declares as wiring. Everything else is
 * identical from tree to tree, so a control and the fixture it controls differ
 * in exactly the thing under test.
 */
function raterTree(params: ContractParam[], source: string, injectedParams?: string[]): FixtureTree {
  return {
    subsystems: [{ id: 'meter-billing', description: 'Consumption billing for metered water connections.' }],
    components: [{
      id: 'consumption-rater',
      componentType: 'Orchestrator',
      subsystem: 'meter-billing',
      description: 'Rates a metered connection\'s consumption against the tariff band it is billed on.',
    }],
    interfaces: [{
      id: 'iconsumption_rater',
      component: 'consumption-rater',
      methods: [{
        name: 'rateConsumption',
        description: 'Rate a billing period\'s consumption for one metered connection.',
        signature: `rateConsumption(${params.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')}): number`,
        returns: 'number',
        params,
      }],
    }],
    implementations: [{
      id: 'consumption_rater_impl',
      contract: 'iconsumption_rater',
      sourcePath: 'src/meter-billing/rater.ts',
      ...(injectedParams ? { injectedParams } : {}),
      methods: [{
        name: 'rateConsumption',
        narrative: [{
          stepNumber: 1,
          type: 'local',
          description: 'Multiply the period\'s kilolitres by the tariff band the connection is billed on.',
        }],
      }],
    }],
    files: { 'src/meter-billing/rater.ts': source },
  };
}

/** The wiring a rater is handed by whatever constructs it — the shape `injectedParams` exists for. */
const WIRING_DECLARATIONS = [
  'export interface BillingConfig { dataRoot: string; }',
  '',
  'export interface MeterArchive { readAt(connectionId: string): number; }',
  '',
].join('\n');

/**
 * One file, read from both sides below. The rater is handed its config AND the
 * meter archive before the two parameters its contract declares; with both
 * names in `injectedParams` the signature matches the contract exactly, and
 * with only `cfg` declared the archive is a leading parameter nothing accounts
 * for. One tree, asserted twice, because silence on either half alone would
 * leave the other free.
 */
const WIRED_RATER = [
  WIRING_DECLARATIONS,
  'export function rateConsumption(',
  '  cfg: BillingConfig,',
  '  archive: MeterArchive,',
  '  connectionId: string,',
  '  kilolitres: number,',
  '): number {',
  '  return archive.readAt(connectionId) + cfg.dataRoot.length * kilolitres;',
  '}',
  '',
].join('\n');

export default [
  // -------------------------------------------------------------------------
  // UNREALIZED_PARAM — fire: the contract promises an argument the code never
  // takes.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    severity: 'warning',
    anchoredTo: 'consumption_rater_impl',
    expectFire: true,
    scenario:
      'The consumption rater\'s contract declares a tariff band alongside the connection and the volume, but the function realizing it takes only the connection and the volume — every brief built from the contract hands an implementer an argument that would go nowhere.',
    tree: raterTree([CONNECTION, VOLUME, BAND], [
      'export function rateConsumption(connectionId: string, kilolitres: number): number {',
      '  return connectionId.length * kilolitres;',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_PARAM — control: the code takes every declared parameter.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: false,
    reason: 'The function takes every parameter the contract declares, which is the whole of the claim.',
    scenario:
      'The consumption rater\'s contract declares the connection, the volume and the tariff band, and the function realizing it takes all three.',
    tree: raterTree([CONNECTION, VOLUME, BAND], [
      'export function rateConsumption(connectionId: string, kilolitres: number, tariffBand: string): number {',
      '  return connectionId.length * kilolitres * tariffBand.length;',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_PARAM — control: a file that only FORWARDS the function holds
  // no signature to read. `methodRealization` owns that absence.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: false,
    reason:
      'The named file only republishes the function — there is no body here whose parameters could be read, and that the body is not here is `methodRealization`\'s finding. A second voice would make one absence look like two.',
    scenario:
      'The consumption rater\'s source file publishes the rater the billing run reaches but imports the rating function itself from the tariff engine, so no signature is declared in it at all.',
    tree: raterTree([CONNECTION, VOLUME, BAND], [
      'import { rateConsumption } from \'./tariff-engine.js\';',
      '',
      '/** The rater a billing run reaches: this module publishes it, the tariff engine writes it. */',
      'export const consumptionRater = { rateConsumption };',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_PARAM — control: an OVERLOADED function answers with the
  // signature that has a body, not with its first overload.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: false,
    reason:
      'The implementation signature — the one with a BODY, and the one a caller actually reaches — takes every declared parameter. Reading the first overload signature instead would report the tariff band as an argument the code never takes.',
    scenario:
      'The consumption rater is overloaded: callers may omit the tariff band, and the implementation signature behind the two overloads takes all three parameters the contract declares.',
    tree: raterTree([CONNECTION, VOLUME, { ...BAND, optional: true }], [
      'export function rateConsumption(connectionId: string, kilolitres: number): number;',
      'export function rateConsumption(connectionId: string, kilolitres: number, tariffBand: string): number;',
      'export function rateConsumption(connectionId: string, kilolitres: number, tariffBand?: string): number {',
      '  return connectionId.length * kilolitres + String(tariffBand).length;',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_PARAM — fire: a LEADING parameter no declared injection
  // accounts for.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    severity: 'warning',
    anchoredTo: 'consumption_rater_impl',
    expectFire: true,
    scenario:
      'The consumption rater is handed its config and the meter archive before the two parameters its contract declares, and the implementation names only the config as wiring — so the archive is an argument every caller must supply that the design never mentions.',
    tree: raterTree(METERED_VOLUME, WIRED_RATER, ['cfg']),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_PARAM — control: the whole declared LEADING RUN is wiring, and
  // is dropped. The same file with `archive` missing from the list is the
  // fixture above.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    expectFire: false,
    reason:
      'Both leading parameters are named in the implementation\'s `injectedParams`: they are supplied by whatever wires the rater up, never by the caller the contract describes, and what remains is exactly the contract\'s own two parameters.',
    scenario:
      'The consumption rater is handed its config and the meter archive before the two parameters its contract declares, and the implementation declares both as the wiring it is constructed with.',
    tree: raterTree(METERED_VOLUME, WIRED_RATER, ['cfg', 'archive']),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_PARAM — fire: a declared injection name appearing AFTER the
  // contract's own parameters is not wiring.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    severity: 'warning',
    anchoredTo: 'consumption_rater_impl',
    expectFire: true,
    scenario:
      'The consumption rater takes its config LAST, after the two parameters its contract declares, so a caller of the contract must supply an argument the design never mentions even though the implementation names that config as wiring.',
    tree: raterTree(METERED_VOLUME, [
      WIRING_DECLARATIONS,
      'export function rateConsumption(connectionId: string, kilolitres: number, cfg: BillingConfig): number {',
      '  return connectionId.length * kilolitres + cfg.dataRoot.length;',
      '}',
      '',
    ].join('\n'), ['cfg']),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_PARAM — fire: the file holds TWO bodies under the name and both
  // take the same undeclared argument, so it is what they agree on.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    severity: 'warning',
    anchoredTo: 'consumption_rater_impl',
    expectFire: true,
    scenario:
      'The rater lives twice in its file — a class member and the facade that forwards to it — and both thread an audit trail the contract never declares, so a caller must supply it whichever one the contract means.',
    tree: raterTree(METERED_VOLUME, [
      'export interface AuditTrail { note(line: string): void; }',
      '',
      'export class TariffRater {',
      '  rateConsumption(connectionId: string, kilolitres: number, audit: AuditTrail): number {',
      '    audit.note(connectionId);',
      '    return connectionId.length * kilolitres;',
      '  }',
      '}',
      '',
      '/** The rater a billing run reaches, built fresh per period. */',
      'export function rateConsumption(connectionId: string, kilolitres: number, audit: AuditTrail): number {',
      '  return new TariffRater().rateConsumption(connectionId, kilolitres, audit);',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_PARAM — control: the two bodies DISAGREE, so nothing is said.
  // The same file with the class member deleted reports the facade's config.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    expectFire: false,
    reason:
      'The file holds two bodies under the name and only the facade takes the config; which one the contract means is not something this reader can decide, so it reports only what both say — and the class member takes exactly the contract\'s two parameters. A wider answer can only narrow what the rule accuses.',
    scenario:
      'The rater lives twice in its file — a class member taking exactly the contract\'s parameters, and the facade that builds it from the billing config first.',
    tree: raterTree(METERED_VOLUME, [
      WIRING_DECLARATIONS,
      'export class TariffRater {',
      '  rateConsumption(connectionId: string, kilolitres: number): number {',
      '    return connectionId.length * kilolitres;',
      '  }',
      '}',
      '',
      '/** The rater a billing run reaches, built from the data root the config names. */',
      'export function rateConsumption(cfg: BillingConfig, connectionId: string, kilolitres: number): number {',
      '  return new TariffRater().rateConsumption(connectionId, kilolitres) + cfg.dataRoot.length;',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // PARAM_NAME_MISMATCH — fire: same position, same type, another word.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PARAM_NAME_MISMATCH',
    severity: 'warning',
    anchoredTo: 'consumption_rater_impl',
    expectFire: true,
    scenario:
      'The consumption rater\'s contract calls its first argument the connection id and the function realizing it calls the same string the connection — one parameter under two names, one of which is what the ERD and every brief carry.',
    tree: raterTree(METERED_VOLUME, [
      'export function rateConsumption(connection: string, kilolitres: number): number {',
      '  return connection.length * kilolitres;',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // PARAM_NAME_MISMATCH — control: the code annotates no type, so nothing is
  // said about the name.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PARAM_NAME_MISMATCH',
    expectFire: false,
    reason:
      'The realizing function annotates its first parameter with nothing, and without the declared type a rename cannot be told from a substitution — a guess about somebody\'s signature is worse than silence. Annotating it `string` is the fixture above.',
    scenario:
      'The consumption rater\'s contract calls its first argument the connection id, and the function realizing it takes an unannotated parameter called the connection.',
    tree: raterTree(METERED_VOLUME, [
      'export function rateConsumption(connection, kilolitres: number): number {',
      '  return String(connection).length * kilolitres;',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // PARAM_OPTIONALITY — fire: the contract lets a caller leave an argument
  // out and the code demands it.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PARAM_OPTIONALITY',
    severity: 'warning',
    anchoredTo: 'consumption_rater_impl',
    expectFire: true,
    scenario:
      'The consumption rater\'s contract says a caller may leave the tariff band out, and the function realizing it demands one — the contract is telling a caller an argument is optional that the code requires.',
    tree: raterTree([CONNECTION, VOLUME, { ...BAND, optional: true }], [
      'export function rateConsumption(connectionId: string, kilolitres: number, tariffBand: string): number {',
      '  return connectionId.length * kilolitres * tariffBand.length;',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // PARAM_OPTIONALITY — control: a DEFAULT VALUE makes an argument omittable
  // exactly as a question mark does.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PARAM_OPTIONALITY',
    expectFire: false,
    reason:
      'The tariff band carries a default, so a caller may leave it out — which is the thing the contract is describing. Deleting the default is the fixture above.',
    scenario:
      'The consumption rater\'s contract says a caller may leave the tariff band out, and the function realizing it defaults an omitted band to the domestic one.',
    tree: raterTree([CONNECTION, VOLUME, { ...BAND, optional: true }], [
      'export function rateConsumption(connectionId: string, kilolitres: number, tariffBand: string = \'domestic\'): number {',
      '  return connectionId.length * kilolitres * tariffBand.length;',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // PARAM_OPTIONALITY — control: a REST parameter is omittable too.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PARAM_OPTIONALITY',
    expectFire: false,
    reason:
      'A rest parameter may be left out entirely, so the code agrees with a contract that calls the readings optional. Dropping the `...` makes the same parameter required and reports the disagreement.',
    scenario:
      'The consumption rater\'s contract says the interim meter readings are optional, and the function realizing it collects them as a rest parameter.',
    tree: raterTree([CONNECTION, { name: 'readings', type: 'number[]', optional: true }], [
      'export function rateConsumption(connectionId: string, ...readings: number[]): number {',
      '  return connectionId.length + readings.length;',
      '}',
      '',
    ].join('\n')),
  }),
];
