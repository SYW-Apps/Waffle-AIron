import { describe, it, expect } from 'vitest';
import { runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// A correct abstraction of every stereotype the mark may stand on, flat and as
// a chain, with its code: the whole rule set must say nothing above a notice.
// A rule that demands behaviour of an abstraction (a narrative, a Store, a
// transport, a body) fails here, whichever rule it is.
// ---------------------------------------------------------------------------

const STEREOTYPES = ['Adapter', 'Orchestrator', 'Supervisor', 'Actor', 'Store', 'Index', 'Query', 'Registry', 'Portal'] as const;
type Stereotype = (typeof STEREOTYPES)[number];

type Specs = NonNullable<FixtureTree['components']>;

const pascal = (id: string): string => id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const contractOf = (id: string): string => `i${id.split('-').join('_')}`;

/** A shipping system: parcel-carrier is the abstraction, road-carrier narrows it in a chain, and dhl and ups implement the narrowest. */
function shipping(stereotype: Stereotype, chained: boolean): FixtureTree {
  const reads = stereotype === 'Index' || stereotype === 'Query';
  const portal = stereotype === 'Portal';
  const owned = stereotype === 'Query';
  const registry = stereotype === 'Registry';
  const verb = reads ? 'trackShipment' : 'shipParcel';
  const effect = reads ? 'read' : 'write';
  const method = (extra: Record<string, unknown> = {}) => ({
    name: verb, description: 'Handle one parcel of the shipment by its reference.', params: [{ name: 'parcel', type: 'string' }], returns: 'void', effect, ...extra,
  });

  const abstractions = chained ? ['parcel-carrier', 'road-carrier'] : ['parcel-carrier'];
  const concrete = ['dhl-carrier', 'ups-carrier'];
  const narrowest = abstractions[abstractions.length - 1];
  const entry = { invokedBy: { kind: 'runtime', caller: 'The composition root hands each parcel to the chosen carrier.' } };

  const components: Specs = [];
  const interfaces: Specs = [];
  const implementations: Specs = [];
  const files: Record<string, string> = {};

  abstractions.forEach((id, at) => {
    const above = at === 0 ? undefined : abstractions[at - 1];
    components.push({ id, componentType: stereotype, abstract: true, description: 'The contract each carrier of parcels implements.', ...(at === 0 && !portal && !owned ? entry : {}) });
    interfaces.push({ id: contractOf(id), component: id, ...(above ? { implements: [above] } : {}), methods: [method()] });
    implementations.push({ id: `${id.split('-').join('_')}_impl`, contract: contractOf(id), sourcePath: `src/${id}.ts`, methods: [{ name: verb }] });
    files[`src/${id}.ts`] = [
      ...(above ? [`import type { ${pascal(above)} } from './${above}';`] : []),
      `export interface ${pascal(id)}${above ? ` extends ${pascal(above)}` : ''} { ${verb}(parcel: string): void }`,
      '',
    ].join('\n');
  });

  concrete.forEach((id) => {
    components.push({
      id,
      componentType: stereotype,
      description: 'One carrier of parcels, used live beside the others.',
      ...(portal ? { transport: 'InProcess', invokedBy: { kind: 'entry', caller: 'Applications linking the shipping library.' } } : {}),
      ...(stereotype === 'Store' ? { durability: 'ram-projection' } : {}),
      ...(registry ? { dependsOn: ['parcel-store'] } : {}),
    });
    interfaces.push({ id: contractOf(id), component: id, implements: [narrowest], methods: [method()] });
    implementations.push({
      id: `${id.split('-').join('_')}_impl`,
      contract: contractOf(id),
      sourcePath: `src/${id}.ts`,
      methods: [{
        name: verb,
        narrative: [registry
          ? { stepNumber: 1, type: 'call', description: 'Record the parcel of this carrier in the store.', targetComponent: 'parcel-store', targetMethod: 'keepBooking' }
          : { stepNumber: 1, type: 'local', description: 'Handle the parcel the way this carrier does, by its reference.' }],
      }],
    });
    files[`src/${id}.ts`] = [
      `import type { ${pascal(narrowest)} } from './${narrowest}';`,
      ...(registry ? ["import { ParcelStore } from './parcel-store';"] : []),
      `export class ${pascal(id)} implements ${pascal(narrowest)} {`,
      ...(registry ? ['  constructor(private readonly store: ParcelStore) {}'] : []),
      `  ${verb}(parcel: string): void { ${registry ? 'this.store.keepBooking(parcel);' : 'void parcel;'} }`,
      '}',
      '',
    ].join('\n');
  });

  if (registry) {
    components.push({ id: 'parcel-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds the parcels every carrier booked.' });
    interfaces.push({ id: 'iparcel_store', component: 'parcel-store', methods: [method({ name: 'keepBooking' })] });
    implementations.push({ id: 'parcel_store_impl', contract: 'iparcel_store', sourcePath: 'src/parcel-store.ts', methods: [{ name: 'keepBooking', narrative: [{ stepNumber: 1, type: 'local', description: 'Keep the parcel under its reference in memory.' }] }] });
    files['src/parcel-store.ts'] = 'export class ParcelStore { keepBooking(parcel: string): void { void parcel; } }\n';
  }

  if (owned) {
    // A Query lives inside the Repository whose Store it reads, an abstraction and its implementers alike.
    components.push(
      { id: 'parcel-repository', componentType: 'Repository', description: 'The one facade over the parcels.', owns: [...abstractions, ...concrete, 'parcel-store'], ...entry },
      { id: 'parcel-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds the parcels of every carrier.' },
    );
    interfaces.push(
      { id: 'iparcel_repository', component: 'parcel-repository', methods: [method(), method({ name: 'findBooking' })] },
      { id: 'iparcel_store', component: 'parcel-store', methods: [method({ name: 'findBooking' })] },
    );
    implementations.push(
      {
        id: 'parcel_repository_impl', contract: 'iparcel_repository', sourcePath: 'src/parcel-repository.ts',
        methods: [
          { name: verb, narrative: [{ stepNumber: 1, type: 'call', description: 'Forward the read to the carrier abstraction.', targetComponent: 'parcel-carrier', targetMethod: verb }] },
          { name: 'findBooking', narrative: [{ stepNumber: 1, type: 'call', description: 'Forward the load to the store of parcels.', targetComponent: 'parcel-store', targetMethod: 'findBooking' }] },
        ],
      },
      { id: 'parcel_store_impl', contract: 'iparcel_store', sourcePath: 'src/parcel-store.ts', methods: [{ name: 'findBooking', narrative: [{ stepNumber: 1, type: 'local', description: 'Look the parcel up by its reference in memory.' }] }] },
    );
    files['src/parcel-store.ts'] = 'export class ParcelStore { findBooking(parcel: string): void { void parcel; } }\n';
    files['src/parcel-repository.ts'] = [
      "import type { ParcelCarrier } from './parcel-carrier';",
      ...abstractions.slice(1).map((id) => `import type { ${pascal(id)} } from './${id}';`),
      ...concrete.map((id) => `import { ${pascal(id)} } from './${id}';`),
      "import { ParcelStore } from './parcel-store';",
      'export class ParcelRepository {',
      `  private readonly carriers: ${pascal(narrowest)}[] = [new DhlCarrier(), new UpsCarrier()];`,
      '  private readonly carrier: ParcelCarrier = this.carriers[0];',
      '  private readonly store = new ParcelStore();',
      '  trackShipment(parcel: string): void { this.carrier.trackShipment(parcel); }',
      '  findBooking(parcel: string): void { this.store.findBooking(parcel); }',
      '}',
      '',
    ].join('\n');
  }

  return {
    system: { name: 'Shipping', vision: 'Ships parcels with several live carriers.' },
    subsystems: [{ id: 'shipping', description: 'Shipping of parcels by carrier.' }],
    components,
    interfaces,
    implementations,
    files,
  };
}

describe('a correct abstraction of every stereotype raises nothing', () => {
  for (const stereotype of STEREOTYPES) {
    for (const chained of [false, true]) {
      it(`${stereotype}, ${chained ? 'as a chain of two abstractions' : 'one level'}`, () => {
        const run = runRuleFixture({ code: 'NONE', expectFire: false, scenario: 'A shipping system whose carriers implement one abstraction of parcels.', tree: shipping(stereotype, chained) });
        expect(run.issues.filter((i) => i.severity !== 'notice').map((i) => `${i.severity} ${i.code} @${i.specId}: ${i.message}`)).toEqual([]);
      });
    }
  }
});
