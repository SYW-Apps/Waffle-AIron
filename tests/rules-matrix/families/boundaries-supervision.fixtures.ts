/**
 * The Supervisor / Actor doctrine and the lifecycle effect, from the rule
 * descriptions in src/core/rules/doctrine/ (supervisor-shared-data,
 * lifecycle-effect-closure, entrypoint-dependencies, member-visibility,
 * pattern-membership, pattern-containment) and the architecture standard:
 *
 *  - A Supervisor may OWN its supervision state — Stores and Registries that
 *    are its own, one hop, private, with full read and write
 *    (SUPERVISOR_CONTAINMENT for anything else it owns). Nobody else depends
 *    on that state: a component that does is the intruder, and the finding is
 *    reported on it (SUPERVISION_STATE_INTRUSION).
 *  - Shared data — a data component the Supervisor does not own — is reached
 *    only through read- and lifecycle-effect methods; a write, or a method
 *    that declares no effect, goes through a workflow
 *    (SUPERVISOR_WRITE_SHORTCUT). A Supervisor's dependsOn edge to a data
 *    component is no edge finding any more; a presentation target is
 *    (ARCHITECTURE_VIOLATION_SUPERVISOR_DEP).
 *  - The lifecycle effect creates, destroys or (un)registers what exists and
 *    is closed under composition (LIFECYCLE_CALLS_WRITE).
 *  - A live Actor is reached through its supervision: a Supervisor that
 *    supervises it, or a Registry such a Supervisor maintains — owns, or calls
 *    with lifecycle-effect methods (ACTOR_REACHED_WITHOUT_SUPERVISOR).
 *
 * Four motivating cases, in a render-farm system:
 *  1. a dispatch workflow reaches a render worker through a router that is
 *     really a Registry of live handles, mistyped as a Store;
 *  2. a component that spawns workers and runs jobs is typed Orchestrator but
 *     is a fused Supervisor and workflow — the split is the fix;
 *  3. a scheduler Supervisor reads guard state and brackets run lifetimes
 *     (open / close / live count) on a shared repository;
 *  4. a Supervisor also reads and writes a shared object heap on behalf of a
 *     call — the write is refused, which forces a marshalling workflow out.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const SYSTEM = {
  name: 'RenderFarm',
  vision: 'A batch render farm: render workers, job dispatch, nightly batch scheduling and frame storage.',
};
const FARM = { id: 'render-farm', description: 'Render workers, job dispatch and batch scheduling.' };
const sub = (components: FixtureTree['components']): FixtureTree['components'] =>
  (components ?? []).map(c => ({ subsystem: FARM.id, ...c }));

// ---------------------------------------------------------------------------
// The live-worker cast shared by cases 1 and 2.
// ---------------------------------------------------------------------------

const WORKER_ACTOR = { id: 'render-worker-actor', componentType: 'Actor', description: 'One live render worker process rendering the frames it is handed.' };
const HANDLE_REGISTRY_IFACE = {
  id: 'iworker_handle_registry',
  component: 'worker-handle-registry',
  methods: [
    { name: 'registerWorker', description: 'Record a started worker\'s live handle under its id.', effect: 'lifecycle' },
    { name: 'unregisterWorker', description: 'Forget a stopped worker\'s live handle.', effect: 'lifecycle' },
    { name: 'lookupWorker', description: 'Find a live worker\'s handle by its id.', effect: 'read' },
  ],
};
const WORKER_IFACE = { id: 'irender_worker_actor', component: 'render-worker-actor', methods: [{ name: 'renderFrame', description: 'Render one frame of a job.' }] };

/** A Supervisor implementation that starts a worker and registers its handle. */
const supervisorImpl = (id: string, contract: string, registry: string) => ({
  id,
  contract,
  methods: [{
    name: 'startWorker',
    narrative: [
      { stepNumber: 1, type: 'local', description: 'Spawn a render worker process and take its live handle.' },
      { stepNumber: 2, type: 'call', description: 'Register the live handle so callers can find the worker by id.', targetComponent: registry, targetMethod: 'registerWorker' },
    ],
  }],
});

/** Case 1/2, the sanctioned shape: the Supervisor maintains the handle Registry, and the workflow looks the worker up there. */
function supervisedThroughRegistryTree(): FixtureTree {
  return {
    system: SYSTEM,
    subsystems: [FARM],
    components: sub([
      { id: 'job-dispatch-orchestrator', componentType: 'Orchestrator', description: 'Sends each render job to the worker it is assigned to.', dependsOn: ['worker-handle-registry', 'render-worker-actor'] },
      { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', dependsOn: ['render-worker-actor', 'worker-handle-registry'] },
      { id: 'worker-handle-registry', componentType: 'Registry', description: 'The live handles of the running render workers, by worker id.', dependsOn: ['worker-handle-store'] },
      { id: 'worker-handle-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds the live worker handles.' },
      WORKER_ACTOR,
    ]),
    interfaces: [
      { id: 'irender_farm_supervisor', component: 'render-farm-supervisor', methods: [{ name: 'startWorker', description: 'Start one render worker.' }] },
      HANDLE_REGISTRY_IFACE,
      WORKER_IFACE,
    ],
    implementations: [supervisorImpl('render_farm_supervisor_impl', 'irender_farm_supervisor', 'worker-handle-registry')],
  };
}

// ---------------------------------------------------------------------------
// Case 3 and 4: a scheduler Supervisor over shared repositories.
// ---------------------------------------------------------------------------

const BATCH_RUN_REPOSITORY = [
  { id: 'batch-run-repository', componentType: 'Repository', description: 'The batch run aggregate: guard state and the live run brackets.', owns: ['batch-run-store', 'batch-run-registry'] },
  { id: 'batch-run-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds the batch guard state and the open runs.' },
  { id: 'batch-run-registry', componentType: 'Registry', description: 'Opens and closes batch runs.', dependsOn: ['batch-run-store'] },
];
const BATCH_RUN_IFACE = {
  id: 'ibatch_run_repository',
  component: 'batch-run-repository',
  methods: [
    { name: 'isQueuePaused', description: 'Whether an operator paused the batch queue.', effect: 'read' },
    { name: 'openRun', description: 'Open a run bracket for a started batch.', effect: 'lifecycle' },
    { name: 'closeRun', description: 'Close the run bracket of a finished batch.', effect: 'lifecycle' },
    { name: 'countLiveRuns', description: 'How many run brackets are open.', effect: 'read' },
    { name: 'recordRunProgress', description: 'Update a run\'s rendered-frame count.', effect: 'write' },
  ],
};
const FRAME_HEAP = [
  { id: 'frame-heap-repository', componentType: 'Repository', description: 'The shared heap of rendered frame objects.', owns: ['frame-heap-store'] },
  { id: 'frame-heap-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds the rendered frame objects.' },
];
const FRAME_HEAP_IFACE = {
  id: 'iframe_heap_repository',
  component: 'frame-heap-repository',
  methods: [
    { name: 'readFrame', description: 'Read a rendered frame object.', effect: 'read' },
    { name: 'storeFrame', description: 'Write a rendered frame object into the heap.', effect: 'write' },
  ],
};

/** The nightly scheduler's tick: guard, bracket, count — plus whatever extra steps a case adds. */
function schedulerTree(extraSteps: object[], extra: Partial<FixtureTree> = {}, extraDeps: string[] = []): FixtureTree {
  return {
    system: SYSTEM,
    subsystems: [FARM],
    components: sub([
      { id: 'nightly-batch-scheduler', componentType: 'Supervisor', description: 'Starts the nightly render batches and brackets each run\'s lifetime.', dependsOn: ['batch-run-repository', ...extraDeps] },
      ...BATCH_RUN_REPOSITORY,
      ...(extra.components ?? []),
    ]),
    interfaces: [
      { id: 'inightly_batch_scheduler', component: 'nightly-batch-scheduler', methods: [{ name: 'runNightlyBatch', description: 'Run one nightly batch.' }] },
      BATCH_RUN_IFACE,
      ...(extra.interfaces ?? []),
    ],
    implementations: [
      {
        id: 'nightly_batch_scheduler_impl',
        contract: 'inightly_batch_scheduler',
        methods: [{
          name: 'runNightlyBatch',
          narrative: [
            { stepNumber: 1, type: 'call', description: 'Read the guard: skip the batch while the queue is paused.', targetComponent: 'batch-run-repository', targetMethod: 'isQueuePaused' },
            { stepNumber: 2, type: 'call', description: 'Open the run bracket for this batch.', targetComponent: 'batch-run-repository', targetMethod: 'openRun' },
            { stepNumber: 3, type: 'call', description: 'Count the live runs to respect the concurrency cap.', targetComponent: 'batch-run-repository', targetMethod: 'countLiveRuns' },
            ...extraSteps,
            { stepNumber: 4 + extraSteps.length, type: 'call', description: 'Close the run bracket when the batch is done.', targetComponent: 'batch-run-repository', targetMethod: 'closeRun' },
          ],
        }],
      },
      ...(extra.implementations ?? []),
    ],
  };
}

export default [
  // -------------------------------------------------------------------------
  // ACTOR_REACHED_WITHOUT_SUPERVISOR — case 1: the router is really a Registry
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ACTOR_REACHED_WITHOUT_SUPERVISOR',
    severity: 'error',
    anchoredTo: 'job-dispatch-orchestrator',
    expectFire: true,
    scenario:
      'The job dispatch workflow resolves a render worker by id through a worker router typed as a Store, so nothing models the lookup hop through the worker supervision.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'job-dispatch-orchestrator', componentType: 'Orchestrator', description: 'Sends each render job to the worker it is assigned to.', dependsOn: ['worker-router-store', 'render-worker-actor'] },
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', dependsOn: ['render-worker-actor', 'worker-router-store'] },
        { id: 'worker-router-store', componentType: 'Store', durability: 'ram-projection', description: 'Routes a worker id to its live handle.' },
        WORKER_ACTOR,
      ]),
    },
  }),
  defineRuleFixture({
    code: 'ACTOR_REACHED_WITHOUT_SUPERVISOR',
    expectFire: false,
    reason: 'The router is typed for what it is — a Registry of live handles the Supervisor keeps through lifecycle-effect calls — and the workflow looks the worker up there: the real lookup hop, supervised reach.',
    scenario:
      'The job dispatch workflow looks a render worker up in the worker handle registry that the render farm supervisor registers each started worker in.',
    tree: supervisedThroughRegistryTree(),
  }),

  // -------------------------------------------------------------------------
  // ACTOR_REACHED_WITHOUT_SUPERVISOR — case 2: a fused Supervisor + workflow
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ACTOR_REACHED_WITHOUT_SUPERVISOR',
    severity: 'error',
    anchoredTo: 'render-pool-orchestrator',
    expectFire: true,
    scenario:
      'The render pool component spawns render workers and also runs jobs on them, typed as an Orchestrator — a Supervisor and a workflow fused into one, with no supervision anywhere.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'render-pool-orchestrator', componentType: 'Orchestrator', description: 'Spawns render workers, restarts crashed ones and runs queued jobs on them.', dependsOn: ['render-worker-actor'] },
        WORKER_ACTOR,
      ]),
    },
  }),
  defineRuleFixture({
    code: 'ACTOR_REACHED_WITHOUT_SUPERVISOR',
    expectFire: false,
    reason: 'Split along its two jobs: the Supervisor spawns the workers and registers their handles through lifecycle calls, and the job workflow finds a worker through that Registry.',
    scenario:
      'The fused render pool is split into a render pool supervisor that spawns and registers workers and a render queue workflow that looks them up by id.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'render-queue-orchestrator', componentType: 'Orchestrator', description: 'Runs queued render jobs on the worker each is assigned to.', dependsOn: ['worker-handle-registry', 'render-worker-actor'] },
        { id: 'render-pool-supervisor', componentType: 'Supervisor', description: 'Spawns render workers and restarts crashed ones.', dependsOn: ['render-worker-actor', 'worker-handle-registry'] },
        { id: 'worker-handle-registry', componentType: 'Registry', description: 'The live handles of the running render workers, by worker id.', dependsOn: ['worker-handle-store'] },
        { id: 'worker-handle-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds the live worker handles.' },
        WORKER_ACTOR,
      ]),
      interfaces: [
        { id: 'irender_pool_supervisor', component: 'render-pool-supervisor', methods: [{ name: 'startWorker', description: 'Start one render worker.' }] },
        HANDLE_REGISTRY_IFACE,
        WORKER_IFACE,
      ],
      implementations: [supervisorImpl('render_pool_supervisor_impl', 'irender_pool_supervisor', 'worker-handle-registry')],
    },
  }),

  // -------------------------------------------------------------------------
  // SUPERVISOR_WRITE_SHORTCUT — cases 3 and 4
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'SUPERVISOR_WRITE_SHORTCUT',
    expectFire: false,
    reason: 'Case 3: the scheduler only reads the guard and the live count and brackets run lifetimes — read and lifecycle methods on shared data, which a Supervisor may call.',
    scenario:
      'The nightly batch scheduler reads the paused guard, opens and closes the run bracket and counts the live runs on the shared batch run repository.',
    tree: schedulerTree([]),
  }),
  defineRuleFixture({
    code: 'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP',
    expectFire: false,
    reason: 'A Supervisor depending on a shared Repository is no edge finding: what it calls there is judged per call, and case 3 calls only read and lifecycle methods.',
    scenario:
      'The nightly batch scheduler depends on the shared batch run repository to guard and bracket its runs.',
    tree: schedulerTree([]),
  }),
  defineRuleFixture({
    code: 'SUPERVISOR_WRITE_SHORTCUT',
    severity: 'error',
    anchoredTo: 'nightly_batch_scheduler_impl',
    expectFire: true,
    scenario:
      'Case 4: on behalf of a render call, the nightly batch scheduler reads a frame object from the shared frame heap and writes the rendered result back into it itself.',
    tree: schedulerTree(
      [
        { stepNumber: 4, type: 'call', description: 'Read the source frame object on behalf of the render call.', targetComponent: 'frame-heap-repository', targetMethod: 'readFrame' },
        { stepNumber: 5, type: 'call', description: 'Write the rendered frame back into the shared heap.', targetComponent: 'frame-heap-repository', targetMethod: 'storeFrame' },
      ],
      { components: FRAME_HEAP, interfaces: [FRAME_HEAP_IFACE] },
      ['frame-heap-repository'],
    ),
  }),
  defineRuleFixture({
    code: 'SUPERVISOR_WRITE_SHORTCUT',
    expectFire: false,
    reason: 'Case 4 resolved: the refused write forced a marshalling workflow out, the read moved with it, and the scheduler calls the workflow — no data call of its own beyond read and lifecycle.',
    scenario:
      'The nightly batch scheduler hands each render result to a frame marshalling workflow, which reads and writes the shared frame heap.',
    tree: schedulerTree(
      [
        { stepNumber: 4, type: 'call', description: 'Hand the render result to the frame marshalling workflow.', targetComponent: 'frame-marshal-orchestrator', targetMethod: 'marshalFrame' },
      ],
      {
        components: [
          ...FRAME_HEAP,
          { id: 'frame-marshal-orchestrator', componentType: 'Orchestrator', description: 'Reads the source frame and stores the rendered result in the shared heap.', dependsOn: ['frame-heap-repository'] },
        ],
        interfaces: [
          FRAME_HEAP_IFACE,
          { id: 'iframe_marshal_orchestrator', component: 'frame-marshal-orchestrator', methods: [{ name: 'marshalFrame', description: 'Store one render result in the frame heap.' }] },
        ],
      },
      ['frame-marshal-orchestrator'],
    ),
  }),
  defineRuleFixture({
    code: 'SUPERVISOR_WRITE_SHORTCUT',
    severity: 'error',
    anchoredTo: 'nightly_batch_scheduler_impl',
    expectFire: true,
    scenario:
      'The nightly batch scheduler bumps a run\'s rendered-frame count on the shared batch run repository — a write to the run\'s fields, not a change to what exists.',
    tree: schedulerTree([
      { stepNumber: 4, type: 'call', description: 'Bump the run\'s rendered-frame count.', targetComponent: 'batch-run-repository', targetMethod: 'recordRunProgress' },
    ]),
  }),
  defineRuleFixture({
    code: 'SUPERVISOR_WRITE_SHORTCUT',
    severity: 'error',
    anchoredTo: 'render_farm_supervisor_impl',
    expectFire: true,
    scenario:
      'The render farm supervisor calls a method on the shared crash log store that declares no effect, so nothing says it is only a read or a lifecycle change.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', dependsOn: ['crash-log-store'] },
        { id: 'crash-log-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds the recent worker crash reports.' },
      ]),
      interfaces: [
        { id: 'irender_farm_supervisor', component: 'render-farm-supervisor', methods: [{ name: 'restartWorker', description: 'Restart a crashed worker.' }] },
        { id: 'icrash_log_store', component: 'crash-log-store', methods: [{ name: 'noteCrash', description: 'Note a worker crash.' }] },
      ],
      implementations: [{
        id: 'render_farm_supervisor_impl',
        contract: 'irender_farm_supervisor',
        methods: [{
          name: 'restartWorker',
          narrative: [
            { stepNumber: 1, type: 'call', description: 'Note the crash in the shared crash log.', targetComponent: 'crash-log-store', targetMethod: 'noteCrash' },
            { stepNumber: 2, type: 'local', description: 'Spawn a fresh worker process in its place.' },
          ],
        }],
      }],
    },
  }),

  // -------------------------------------------------------------------------
  // Supervision state: owned, private, full read/write
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'SUPERVISOR_WRITE_SHORTCUT',
    expectFire: false,
    reason: 'The restart counts are the Supervisor\'s own supervision state (it owns the Store), so it reads and writes them in full.',
    scenario:
      'The render farm supervisor owns its restart-count store and bumps a worker\'s restart count on every restart.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', owns: ['restart-count-store'] },
        { id: 'restart-count-store', componentType: 'Store', durability: 'ram-projection', description: 'Each worker\'s restart count in the current window.' },
      ]),
      interfaces: [
        { id: 'irender_farm_supervisor', component: 'render-farm-supervisor', methods: [{ name: 'restartWorker', description: 'Restart a crashed worker.' }] },
        { id: 'irestart_count_store', component: 'restart-count-store', methods: [{ name: 'bumpRestarts', description: 'Count one more restart for a worker.', effect: 'write' }] },
      ],
      implementations: [{
        id: 'render_farm_supervisor_impl',
        contract: 'irender_farm_supervisor',
        methods: [{
          name: 'restartWorker',
          narrative: [
            { stepNumber: 1, type: 'call', description: 'Count the restart against the worker.', targetComponent: 'restart-count-store', targetMethod: 'bumpRestarts' },
            { stepNumber: 2, type: 'local', description: 'Spawn a fresh worker process in its place.' },
          ],
        }],
      }],
    },
  }),
  defineRuleFixture({
    code: 'BLOCK_OWNS_MEMBERS',
    expectFire: false,
    reason: 'A Supervisor is the one building block that may own: its supervision state.',
    scenario: 'The render farm supervisor owns the store of its workers\' restart counts.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', owns: ['restart-count-store'] },
        { id: 'restart-count-store', componentType: 'Store', durability: 'ram-projection', description: 'Each worker\'s restart count in the current window.' },
      ]),
    },
  }),
  defineRuleFixture({
    code: 'SUPERVISOR_CONTAINMENT',
    severity: 'error',
    anchoredTo: 'render-farm-supervisor',
    expectFire: true,
    scenario: 'The render farm supervisor claims the job dispatch workflow as owned, as if a workflow were supervision state.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', owns: ['job-dispatch-orchestrator'] },
        { id: 'job-dispatch-orchestrator', componentType: 'Orchestrator', description: 'Sends each render job to the worker it is assigned to.' },
      ]),
    },
  }),
  defineRuleFixture({
    code: 'SUPERVISOR_CONTAINMENT',
    expectFire: false,
    reason: 'A Store and a Registry are exactly what a Supervisor may own as its supervision state.',
    scenario: 'The render farm supervisor owns its restart-count store and the registry of its live worker handles.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', owns: ['restart-count-store', 'worker-handle-registry'] },
        { id: 'restart-count-store', componentType: 'Store', durability: 'ram-projection', description: 'Each worker\'s restart count in the current window.' },
        { id: 'worker-handle-registry', componentType: 'Registry', description: 'The live handles of the running render workers.', dependsOn: ['restart-count-store'] },
      ]),
    },
  }),
  defineRuleFixture({
    code: 'SUPERVISION_STATE_INTRUSION',
    severity: 'error',
    anchoredTo: 'job-dispatch-orchestrator',
    expectFire: true,
    scenario:
      'The job dispatch workflow reads the restart-count store that the render farm supervisor owns as its supervision state, to skip flaky workers.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'job-dispatch-orchestrator', componentType: 'Orchestrator', description: 'Sends each render job to a worker, skipping flaky ones.', dependsOn: ['restart-count-store'] },
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', owns: ['restart-count-store'] },
        { id: 'restart-count-store', componentType: 'Store', durability: 'ram-projection', description: 'Each worker\'s restart count in the current window.' },
      ]),
    },
  }),
  defineRuleFixture({
    code: 'SUPERVISION_STATE_INTRUSION',
    severity: 'error',
    anchoredTo: 'job-dispatch-orchestrator',
    expectFire: true,
    scenario:
      'The job dispatch workflow looks workers up in the handle registry the render farm supervisor OWNS privately — supervised reach, but an intrusion on private supervision state.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'job-dispatch-orchestrator', componentType: 'Orchestrator', description: 'Sends each render job to the worker it is assigned to.', dependsOn: ['worker-handle-registry', 'render-worker-actor'] },
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', dependsOn: ['render-worker-actor'], owns: ['worker-handle-registry'] },
        { id: 'worker-handle-registry', componentType: 'Registry', description: 'The live handles of the running render workers, by worker id.' },
        WORKER_ACTOR,
      ]),
    },
  }),
  defineRuleFixture({
    code: 'ACTOR_REACHED_WITHOUT_SUPERVISOR',
    expectFire: false,
    reason: 'A Registry the Supervisor owns is one it maintains, so the reach is supervised; the private state being depended on is SUPERVISION_STATE_INTRUSION\'s one finding, not this.',
    scenario:
      'The job dispatch workflow looks workers up in the handle registry the render farm supervisor owns.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'job-dispatch-orchestrator', componentType: 'Orchestrator', description: 'Sends each render job to the worker it is assigned to.', dependsOn: ['worker-handle-registry', 'render-worker-actor'] },
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', dependsOn: ['render-worker-actor'], owns: ['worker-handle-registry'] },
        { id: 'worker-handle-registry', componentType: 'Registry', description: 'The live handles of the running render workers, by worker id.' },
        WORKER_ACTOR,
      ]),
    },
  }),
  defineRuleFixture({
    code: 'SUPERVISION_STATE_INTRUSION',
    expectFire: false,
    reason: 'The handle Registry is shared data, owned by nobody: the Supervisor keeps it through lifecycle calls and the workflow reads it — no private state is intruded on.',
    scenario:
      'The job dispatch workflow looks workers up in a shared handle registry that the render farm supervisor maintains through lifecycle calls.',
    tree: supervisedThroughRegistryTree(),
  }),
  defineRuleFixture({
    code: 'SHARED_OWNED_MEMBER',
    severity: 'error',
    expectFire: true,
    scenario:
      'Both the worker roster repository and the render farm supervisor claim the worker roster store as owned.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'worker-roster-repository', componentType: 'Repository', description: 'The worker roster aggregate.', owns: ['worker-roster-store'] },
        { id: 'render-farm-supervisor', componentType: 'Supervisor', description: 'Starts, restarts and stops the render worker processes.', owns: ['worker-roster-store'] },
        { id: 'worker-roster-store', componentType: 'Store', durability: 'ram-projection', description: 'The configured render workers.' },
      ]),
    },
  }),

  // -------------------------------------------------------------------------
  // ARCHITECTURE_VIOLATION_SUPERVISOR_DEP — presentation is out of reach
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP',
    severity: 'error',
    anchoredTo: 'render-farm-supervisor',
    expectFire: true,
    scenario: 'The render farm supervisor depends on the farm status view to repaint it on every worker restart.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'farm-console', description: 'The operator console of the render farm.' }],
      components: [
        { id: 'render-farm-supervisor', componentType: 'Supervisor', subsystem: 'farm-console', description: 'Starts, restarts and stops the render worker processes.', dependsOn: ['farm-status-view'] },
        { id: 'farm-status-view', componentType: 'View', subsystem: 'farm-console', description: 'Renders the live worker status board.' },
      ],
      projectType: 'frontend-reactive',
    },
  }),

  // -------------------------------------------------------------------------
  // LIFECYCLE_CALLS_WRITE — the lifecycle effect is closed under composition
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'LIFECYCLE_CALLS_WRITE',
    severity: 'error',
    anchoredTo: 'worker_handle_registry_impl',
    expectFire: true,
    scenario:
      'Registering a worker handle is declared a lifecycle change, but its narrative also updates the worker\'s stats record — a write to domain fields.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'worker-handle-registry', componentType: 'Registry', description: 'The live handles of the running render workers, by worker id.', dependsOn: ['worker-handle-store'] },
        { id: 'worker-handle-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds the live worker handles and their stats.' },
      ]),
      interfaces: [
        { id: 'iworker_handle_registry', component: 'worker-handle-registry', methods: [{ name: 'registerWorker', description: 'Record a started worker\'s live handle.', effect: 'lifecycle' }] },
        {
          id: 'iworker_handle_store',
          component: 'worker-handle-store',
          methods: [
            { name: 'insertHandle', description: 'Add a live handle.', effect: 'lifecycle' },
            { name: 'updateWorkerStats', description: 'Overwrite a worker\'s stats record.', effect: 'write' },
          ],
        },
      ],
      implementations: [{
        id: 'worker_handle_registry_impl',
        contract: 'iworker_handle_registry',
        methods: [{
          name: 'registerWorker',
          narrative: [
            { stepNumber: 1, type: 'call', description: 'Add the live handle.', targetComponent: 'worker-handle-store', targetMethod: 'insertHandle' },
            { stepNumber: 2, type: 'call', description: 'Reset the worker\'s stats record.', targetComponent: 'worker-handle-store', targetMethod: 'updateWorkerStats' },
          ],
        }],
      }],
    },
  }),
  defineRuleFixture({
    code: 'LIFECYCLE_CALLS_WRITE',
    expectFire: false,
    reason: 'A lifecycle method composed only of lifecycle calls keeps its declaration true.',
    scenario: 'Registering a worker handle only adds the live handle to the store.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'worker-handle-registry', componentType: 'Registry', description: 'The live handles of the running render workers, by worker id.', dependsOn: ['worker-handle-store'] },
        { id: 'worker-handle-store', componentType: 'Store', durability: 'ram-projection', description: 'Holds the live worker handles.' },
      ]),
      interfaces: [
        { id: 'iworker_handle_registry', component: 'worker-handle-registry', methods: [{ name: 'registerWorker', description: 'Record a started worker\'s live handle.', effect: 'lifecycle' }] },
        { id: 'iworker_handle_store', component: 'worker-handle-store', methods: [{ name: 'insertHandle', description: 'Add a live handle.', effect: 'lifecycle' }] },
      ],
      implementations: [{
        id: 'worker_handle_registry_impl',
        contract: 'iworker_handle_registry',
        methods: [{
          name: 'registerWorker',
          narrative: [
            { stepNumber: 1, type: 'call', description: 'Add the live handle.', targetComponent: 'worker-handle-store', targetMethod: 'insertHandle' },
          ],
        }],
      }],
    },
  }),

  // -------------------------------------------------------------------------
  // The existing effect consumers read lifecycle as a mutation
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT',
    severity: 'error',
    anchoredTo: 'farm_api_impl',
    expectFire: true,
    scenario: 'The farm API portal opens a batch run bracket by calling the repository\'s lifecycle-effect openRun directly, skipping the workflow layer.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'farm-api-portal', componentType: 'Portal', portalType: 'Custom', description: 'Operator API of the render farm.', dependsOn: ['batch-run-repository'] },
        ...BATCH_RUN_REPOSITORY,
      ]),
      interfaces: [
        { id: 'ifarm_api', component: 'farm-api-portal', methods: [{ name: 'startBatch', description: 'Start a batch by hand.' }] },
        BATCH_RUN_IFACE,
      ],
      implementations: [{
        id: 'farm_api_impl',
        contract: 'ifarm_api',
        methods: [{
          name: 'startBatch',
          narrative: [
            { stepNumber: 1, type: 'call', description: 'Open the run bracket straight through the repository facade.', targetComponent: 'batch-run-repository', targetMethod: 'openRun' },
          ],
        }],
      }],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_HYDRATION',
    severity: 'error',
    anchoredTo: 'render-job-store',
    expectFire: true,
    scenario: 'The durable render job store only ever adds and removes jobs through lifecycle methods, and nothing reads them back at boot.',
    tree: {
      system: SYSTEM,
      subsystems: [FARM],
      components: sub([
        { id: 'render-job-store', componentType: 'Store', durability: 'durable', description: 'The persisted queue of render jobs.' },
      ]),
      interfaces: [{
        id: 'irender_job_store',
        component: 'render-job-store',
        methods: [
          { name: 'enqueueJob', description: 'Add a job to the queue.', effect: 'lifecycle' },
          { name: 'dropJob', description: 'Remove a job from the queue.', effect: 'lifecycle' },
          { name: 'listJobs', description: 'List the queued jobs.', effect: 'read' },
        ],
      }],
    },
  }),
];
