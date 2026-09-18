import { SddRule } from '../types.js';
import { isPureLogic, stereotypeOf } from './stereotype-terms.js';

/**
 * What the data layer may depend on. A Store, its Registry, its Indexes and
 * its Queries all face the same way: down, toward their own Store and the
 * backend Adapter that serves it, with pure logic where a value must be
 * computed. An Adapter is the sink at the bottom. None of them reaches back up
 * into workflow.
 */
export const dataBlockDepsRule: SddRule = {
  name: 'data-block-dependencies',
  description:
    'Keeps the data layer facing down. A Store may depend only on another Store, a backend Adapter or pure logic — Registries and Indexes depend on the Store, never the reverse. A Registry is the write path to its Store and may depend on that Store, a backend Adapter, or the pure logic that validates the write. An Index is a read projection and a Query a computed read, each over its Store through a backend Adapter where one serves it. An Adapter is a sink toward the system: it may use pure logic, but never a Store or any other Orchestrator.',
  codes: [
    { code: 'ARCHITECTURE_VIOLATION_STORE_DEP', defaultSeverity: 'error', summary: 'Store depending on anything but another Store, a backend Adapter or pure logic' },
    { code: 'ARCHITECTURE_VIOLATION_REGISTRY_DEP', defaultSeverity: 'warning', summary: 'Registry depending on anything but its Store, a backend Adapter or pure logic (warning while new; aligned to the standard §7 validate→write path)' },
    { code: 'ARCHITECTURE_VIOLATION_ADAPTER_DEP', defaultSeverity: 'error', summary: 'Adapter depending on a Store or on an Orchestrator that is not pure' },
    { code: 'ARCHITECTURE_VIOLATION_INDEX_DEP', defaultSeverity: 'error', summary: 'Index depending on anything but its Store, an Adapter or pure logic' },
    { code: 'ARCHITECTURE_VIOLATION_QUERY_DEP', defaultSeverity: 'error', summary: 'Query depending on anything but its Store, a backend Adapter or pure logic' },
  ],
  check(ctx) {
    for (const edge of ctx.dependencyEdges().matrix) {
      const comp = edge.from;
      const depComp = edge.to;

      // A Portal or Observer target is entrypoint-dependencies' one finding on
      // that edge (ARCHITECTURE_VIOLATION_PORTAL_DEP): no consumer-side matrix
      // check reports the same edge again.
      if (depComp.componentType === 'Portal' || depComp.componentType === 'Observer') continue;

      const depPure = isPureLogic(depComp);
      // The three read/write blocks of a Repository share one allowance: their
      // own Store, the backend Adapter serving it, and pure logic.
      const ownStoreOnly = depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter' && !depPure;

      // Store rule: a Store may depend only on another Store, its backend
      // Adapter, or pure logic. It is depended upon by Registries/Indexes —
      // never the reverse.
      if (comp.componentType === 'Store' && ownStoreOnly) {
        ctx.addIssue(
          'error',
          'ARCHITECTURE_VIOLATION_STORE_DEP',
          `Architectural violation: Store component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Stores may only depend on other Stores, a backend Adapter or pure logic — Registries and Indexes depend on the Store, never the reverse.`,
          comp.id,
          edge.draftContext,
        );
      }

      // Registry rule: the write path to its Store — validate → store.write.
      // It may depend on that Store, a backend Adapter, or the pure logic that
      // validates the write (the standard's §7 write path); reaching
      // workflow, read projections, or boundaries inverts the layering.
      // Warning while the check is new.
      if (comp.componentType === 'Registry' && ownStoreOnly) {
        ctx.addIssue(
          'warning',
          'ARCHITECTURE_VIOLATION_REGISTRY_DEP',
          `Architectural violation: Registry component "${comp.id}" should not depend on "${depComp.componentType}" component "${depComp.id}". A Registry is the write path to its Store and may depend only on that Store, a backend Adapter, or pure logic that validates the write — the Registry never updates Indexes and never drives workflow.`,
          comp.id,
          edge.draftContext,
        );
      }

      // Adapter rule: an Adapter is a sink toward the system. It may use pure
      // logic, but never a Store or any other Orchestrator.
      if (comp.componentType === 'Adapter'
        && (depComp.componentType === 'Store' || (depComp.componentType === 'Orchestrator' && !depPure))) {
        ctx.addIssue(
          'error',
          'ARCHITECTURE_VIOLATION_ADAPTER_DEP',
          `Architectural violation: Adapter component "${comp.id}" cannot depend on ${stereotypeOf(depComp)} component "${depComp.id}". An Adapter may use pure logic, but never a Store or any other Orchestrator.`,
          comp.id,
          edge.draftContext,
        );
      }

      // Index rule: a read projection — may depend only on its Store, a
      // backend Adapter, or pure logic.
      if (comp.componentType === 'Index' && ownStoreOnly) {
        ctx.addIssue(
          'error',
          'ARCHITECTURE_VIOLATION_INDEX_DEP',
          `Architectural violation: Index component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". An Index is a read projection and may depend only on its Store, a backend Adapter or pure logic.`,
          comp.id,
          edge.draftContext,
        );
      }

      // Query rule: a computed read over its Repository's Store — its Store, a
      // backend Adapter where one serves it, and pure logic.
      if (comp.componentType === 'Query' && ownStoreOnly) {
        ctx.addIssue(
          'error',
          'ARCHITECTURE_VIOLATION_QUERY_DEP',
          `Architectural violation: Query "${comp.id}" cannot depend on ${stereotypeOf(depComp)} "${depComp.id}". A Query computes reads over its Store, through a backend Adapter where one serves it, with pure logic — move any other dependency to the workflow that calls the Repository facade.`,
          comp.id,
          edge.draftContext,
        );
      }
    }
  },
};
