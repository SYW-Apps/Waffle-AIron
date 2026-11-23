import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot, listFilesRecursive } from '../../src/utils/fs.js';
import { invalidateSpecCache, loadInterfaceSpec, loadInterfaceSpecs, loadComponentSpecs } from '../../src/core/specs.js';
import { renameComponent, renameMethod, renameParam, planRenameCascade, moveContractMethod } from '../../src/core/provision.js';
import { deleteSpec, moveSpec } from '../../src/core/authoring.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { interfaceDesignView } from '../../src/models/specs.js';
import { projectFamilyGraph } from '../../src/core/project-family.js';

// ---------------------------------------------------------------------------
// An `implements` entry is a component reference, and renaming an abstraction's
// method or parameter follows onto every implementer of the project. Every
// scenario is a real temporary project on disk; nothing here touches this
// repository's own .wai.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const SUB = { id: 'zoo', description: 'The zoo.' };
const SPEAK = { name: 'speak', description: 'Make a sound.', params: [{ name: 'volume', type: 'int' }], returns: 'void' };

type Comps = NonNullable<FixtureTree['components']>;
const inZoo = (components: Comps): Comps => components.map((c) => ({ subsystem: SUB.id, ...c }));

/** Write a tree into a fresh temp project and bind it. */
function project(tree: FixtureTree): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-c2b-')));
  roots.push(dir);
  materializeFixtureProject(dir, tree);
  setProjectRoot(dir);
  invalidateSpecCache();
  return dir;
}

/** Every file under a project, by relative path, with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** A stored spec file's content, found by its id (the layout is flat). */
function storedSpec(dir: string, id: string): any {
  const file = listFilesRecursive(path.join(dir, '.wai', 'specs'), '.yaml').find((f) => (readYamlFile(f) as any)?.id === id);
  return file ? readYamlFile(file) : undefined;
}

const mm = (m: unknown): any => m;

/** animal (abstract) <- dog (abstract) <- retriever (concrete): the chain of three, each level a whole contract. */
function chain(over: { retrieverImplements?: string | string[]; extra?: Comps } = {}): FixtureTree {
  return {
    system: { name: 'Zoo', vision: 'A zoo of animals.' },
    subsystems: [SUB],
    components: inZoo([
      { id: 'animal', componentType: 'Orchestrator', abstract: true, description: 'Any animal.' },
      { id: 'dog', componentType: 'Orchestrator', abstract: true, description: 'Any dog.' },
      { id: 'retriever', componentType: 'Orchestrator', description: 'A retriever.', invokedBy: { kind: 'runtime', caller: 'The keeper calls it.' } },
      ...(over.extra ?? []),
    ]),
    interfaces: [
      { id: 'ianimal', component: 'animal', methods: [SPEAK] },
      { id: 'idog', component: 'dog', implements: ['animal'], methods: [SPEAK] },
      { id: 'iretriever', component: 'retriever', implements: over.retrieverImplements ?? 'dog', methods: [SPEAK] },
    ],
    implementations: [
      { id: 'retriever_impl', contract: 'iretriever', methods: [{ name: 'speak', narrative: [{ stepNumber: 1, type: 'local', description: 'Bark.' }] }] },
    ],
  };
}

describe('a local implements entry is a component reference', () => {
  it('loads as the bound component key, a string or a list entry alike', () => {
    project(chain());
    expect(loadInterfaceSpec('iretriever')?.implements).toEqual(['dog']);
    expect(loadInterfaceSpec('idog')?.implements).toEqual(['animal']);
  });

  it('renames the abstraction in a string entry and in a list entry, never an alias::name entry', () => {
    const dir = project(chain({ extra: [] }));
    // The list entry of dog and the string entry of retriever both name an abstraction; add an alias entry beside one.
    const dogFile = listFilesRecursive(path.join(dir, '.wai', 'specs'), '.yaml').find((f) => (readYamlFile(f) as any)?.id === 'idog')!;
    const dog = readYamlFile(dogFile) as any;
    expect(dog.implements).toEqual(['animal']);
    const receipt = renameComponent('animal', 'creature');
    expect(receipt.rewritten).toContain('idog');
    expect(storedSpec(dir, 'idog').implements).toEqual(['creature']);
    // A string stays a string.
    renameComponent('dog', 'hound');
    expect(storedSpec(dir, 'iretriever').implements).toBe('hound');
  });

  it('leaves an alias::name entry as written when a component of the same name is renamed', () => {
    const dir = project({
      ...chain(),
      interfaces: [
        { id: 'ianimal', component: 'animal', methods: [SPEAK] },
        { id: 'idog', component: 'dog', implements: ['animal', 'ext::animal'], methods: [SPEAK] },
        { id: 'iretriever', component: 'retriever', implements: 'dog', methods: [SPEAK] },
      ],
    });
    renameComponent('animal', 'creature');
    expect(storedSpec(dir, 'idog').implements).toEqual(['creature', 'ext::animal']);
  });

  it('is found by referencesTo and refuses a delete naming the implements entry', () => {
    const dir = project(chain());
    const before = snapshot(dir);
    expect(() => deleteSpec('component', 'animal', false, false)).toThrow(/implements/);
    expect(snapshot(dir)).toEqual(before);
    const dry = deleteSpec('component', 'animal', true, false) as any;
    expect(JSON.stringify(dry)).toMatch(/implements/);
  });

  it('is a reference the loader and the design view digest the same way whatever its written form', () => {
    const asString = interfaceDesignView({ id: 'i', component: 'c', implements: 'a' } as any);
    const asList = interfaceDesignView({ id: 'i', component: 'c', implements: ['a'] } as any);
    const two = interfaceDesignView({ id: 'i', component: 'c', implements: ['a', 'b'] } as any);
    const empty = interfaceDesignView({ id: 'i', component: 'c', implements: [] } as any);
    const absent = interfaceDesignView({ id: 'i', component: 'c' } as any);
    expect(JSON.stringify(asString)).toBe(JSON.stringify(asList));
    expect(JSON.stringify(asList)).not.toBe(JSON.stringify(two));
    expect(JSON.stringify(empty)).toBe(JSON.stringify(absent));
    expect((asList as any).implements).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// The rename cascade: renaming a method or a parameter of an abstraction
// follows onto every implementer of the project, all or nothing.
// ---------------------------------------------------------------------------

import { readYamlFile as readYaml, writeYamlFile as writeYaml } from '../../src/utils/yaml.js';
import { runWithProjectBinding } from '../../src/utils/fs.js';

/** Rewrite one stored spec file in place through `change`. */
function patch(dir: string, id: string, change: (doc: any) => void): void {
  const file = listFilesRecursive(path.join(dir, '.wai', 'specs'), '.yaml').find((f) => (readYaml(f) as any)?.id === id);
  if (!file) throw new Error(`no spec ${id}`);
  const doc = readYaml(file) as any;
  change(doc);
  writeYaml(file, doc);
  invalidateSpecCache();
}

/** The chain with a caller that calls the abstraction and the concrete implementer, and an implementation at every level. */
function zoo(): FixtureTree {
  const tree = chain();
  tree.components!.push({ subsystem: SUB.id, id: 'keeper', componentType: 'Orchestrator', description: 'Keeps the animals.', dependsOn: ['animal', 'retriever'], invokedBy: { kind: 'runtime', caller: 'The zoo opens.' } });
  tree.interfaces!.push({ id: 'ikeeper', component: 'keeper', methods: [{ name: 'feed', description: 'Feed them.', returns: 'void' }] });
  tree.implementations!.push(
    { id: 'animal_impl', contract: 'ianimal', methods: [{ name: 'speak' }] },
    { id: 'dog_impl', contract: 'idog', methods: [{ name: 'speak' }] },
    {
      id: 'keeper_impl', contract: 'ikeeper',
      methods: [{
        name: 'feed',
        narrative: [
          { stepNumber: 1, type: 'call', description: 'Ask any animal.', targetComponent: 'animal', targetMethod: 'speak' },
          { stepNumber: 2, type: 'call', description: 'Ask the retriever.', targetComponent: 'retriever', targetMethod: 'speak' },
        ],
      }],
    },
  );
  return tree;
}

const stepsOf = (dir: string, impl: string, method: string): { targetComponent?: string; targetMethod?: string }[] =>
  storedSpec(dir, impl).methods.find((m: any) => m.name === method).narrative;

describe('renaming a method of an abstraction follows onto its implementers', () => {
  it('moves it on every level of a chain of three, with each contract\'s own trace, and names what followed', () => {
    const dir = project(zoo());
    const report = renameMethod('animal', 'speak', 'bark');
    expect(report.followed).toEqual(['dog.bark', 'retriever.bark']);
    for (const [id, contract] of [['animal', 'ianimal'], ['dog', 'idog'], ['retriever', 'iretriever']] as const) {
      const method = storedSpec(dir, contract).methods.map(mm)[0];
      expect(method.name, id).toBe('bark');
      expect(method.previousNames).toEqual([`${contract}.speak`]);
    }
    expect(storedSpec(dir, 'retriever_impl').methods[0].name).toBe('bark');
    expect(storedSpec(dir, 'retriever_impl').methods[0].narrative[0].description).toBe('Bark.');
    expect(storedSpec(dir, 'dog_impl').methods[0].name).toBe('bark');
    expect(report.renamed).toEqual(expect.arrayContaining(['ianimal', 'animal_impl', 'idog', 'dog_impl', 'iretriever', 'retriever_impl']));
    // Every call to the abstraction and to the implementer follows.
    expect(stepsOf(dir, 'keeper_impl', 'feed').map((s) => `${s.targetComponent}.${s.targetMethod}`)).toEqual(['animal.bark', 'retriever.bark']);
  });

  it('answers the same on a dry run and writes nothing', () => {
    const dir = project(zoo());
    const before = snapshot(dir);
    const dry = renameMethod('animal', 'speak', 'bark', undefined, true);
    expect(dry.dryRun).toBe(true);
    expect(dry.followed).toEqual(['dog.bark', 'retriever.bark']);
    expect(dry.renamed).toEqual(expect.arrayContaining(['idog', 'iretriever', 'retriever_impl']));
    expect(dry.rewritten).toContain('keeper_impl');
    expect(snapshot(dir)).toEqual(before);
    // The control: nothing implements a plain component, so nothing follows.
    expect(renameMethod('keeper', 'feed', 'nourish', undefined, true).followed).toEqual([]);
  });

  it('follows through a diamond once, and terminates on a cycle', () => {
    // retriever implements both dog and cat; dog and cat both implement animal.
    const diamond = zoo();
    diamond.components!.push({ subsystem: SUB.id, id: 'cat', componentType: 'Orchestrator', abstract: true, description: 'Any cat.' });
    diamond.interfaces!.push({ id: 'icat', component: 'cat', implements: ['animal'], methods: [SPEAK] });
    diamond.interfaces = diamond.interfaces!.map((i) => (i.id === 'iretriever' ? { ...i, implements: ['dog', 'cat'] } : i));
    const dir = project(diamond);
    const report = renameMethod('animal', 'speak', 'bark');
    expect([...report.followed].sort()).toEqual(['cat.bark', 'dog.bark', 'retriever.bark']);
    expect(storedSpec(dir, 'iretriever').methods[0].previousNames).toEqual(['iretriever.speak']);
    expect(storedSpec(dir, 'iretriever').methods).toHaveLength(1);
    setProjectRoot(null);

    // animal and dog implement each other: the plan stops at the component already visited.
    const cycle = chain();
    cycle.interfaces = cycle.interfaces!.map((i) => (i.id === 'ianimal' ? { ...i, implements: ['dog'] } : i));
    project(cycle);
    expect(planRenameCascade('animal', 'speak', 'bark').map((f) => f.component)).toEqual(['dog', 'retriever']);
  });

  it('renames the omits entry of a Portal implementer in place, keeping its reason', () => {
    const tree: FixtureTree = {
      system: { name: 'Zoo', vision: 'A zoo.' },
      subsystems: [SUB],
      components: inZoo([
        { id: 'zoo-api', componentType: 'Portal', abstract: true, description: 'The verbs.' },
        { id: 'zoo-cli', componentType: 'Portal', transport: 'CLI', invokedBy: { kind: 'entry', caller: 'Keepers.' }, description: 'On a command line.' },
        { id: 'zoo-rest', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Browsers.' }, description: 'Over HTTP.' },
      ]),
      interfaces: [
        { id: 'izoo_api', component: 'zoo-api', methods: [SPEAK, { name: 'watch', description: 'Stream.', returns: 'void' }] },
        { id: 'izoo_cli', component: 'zoo-cli', implements: ['zoo-api'], omits: [{ method: 'watch', reason: 'No streaming on a command line.' }], methods: [{ ...SPEAK, endpoint: { transport: 'CLI', command: 'zoo speak' } }] },
        { id: 'izoo_rest', component: 'zoo-rest', implements: ['zoo-api'], methods: [{ ...SPEAK, endpoint: { transport: 'HTTP', method: 'POST', path: '/speak' } }, { name: 'watch', description: 'Stream.', returns: 'void', endpoint: { transport: 'HTTP', method: 'GET', path: '/watch' } }] },
      ],
      implementations: [],
    };
    const dir = project(tree);
    const report = renameMethod('zoo-api', 'watch', 'observe');
    // The CLI only lists the verb: its omits entry follows, and it declares no method of that name.
    expect(storedSpec(dir, 'izoo_cli').omits).toEqual([{ method: 'observe', reason: 'No streaming on a command line.' }]);
    expect(report.followed).toEqual(['zoo-rest.observe']);
    expect(report.renamed).toContain('izoo_cli');
    expect(storedSpec(dir, 'izoo_rest').methods.map(mm).map((m: any) => m.name)).toEqual(['speak', 'observe']);
  });

  it('retargets a signatureFrom, the lint allows and the debt register of every renamed method', () => {
    const dir = project(zoo());
    patch(dir, 'idog', (doc) => { doc.methods[0] = { name: 'speak', description: 'Make a sound.', signatureFrom: 'animal.speak' }; });
    patch(dir, 'iretriever', (doc) => { doc.lint = { allow: [{ code: 'UNUSED_METHOD', at: 'speak', reason: 'runtime' }] }; });
    patch(dir, 'keeper_impl', (doc) => { doc.lint = { allow: [{ code: 'CALL_STEP_UNREALIZED', at: 'feed', covers: ['2:retriever.speak'], reason: 'r' }] }; });
    const yamlFile = path.join(dir, '.wai', 'project.yaml');
    const config = readYaml(yamlFile) as any;
    config.rules = { ...(config.rules ?? {}), conformance: { carried: [{ kind: 'undecided', why: 'later', findings: [{ code: 'UNDECLARED_PARAM', spec: 'iretriever', at: 'speak' }] }] } };
    writeYaml(yamlFile, config);
    invalidateSpecCache();
    const report = renameMethod('animal', 'speak', 'bark');
    expect(storedSpec(dir, 'idog').methods[0].signatureFrom).toBe('animal.bark');
    expect(storedSpec(dir, 'iretriever').lint.allow[0].at).toBe('bark');
    expect(storedSpec(dir, 'keeper_impl').lint.allow[0].covers).toEqual(['2:retriever.bark']);
    expect(report.carried).toEqual([expect.objectContaining({ spec: 'iretriever', from: 'speak', to: 'bark' })]);
    expect((readYaml(yamlFile) as any).rules.conformance.carried[0].findings[0].at).toBe('bark');
  });

  it('pins a symbol per follower: only where its code exists, always when asked, never when declined', () => {
    const tree = zoo();
    tree.files = { 'src/retriever.ts': 'export function speak(): void {}\n' };
    tree.implementations = tree.implementations!.map((i) => (i.id === 'retriever_impl' ? { ...i, sourcePath: 'src/retriever.ts' } : i.id === 'dog_impl' ? { ...i, sourcePath: 'src/dog.ts' } : i));
    const dir = project(tree);
    renameMethod('animal', 'speak', 'bark');
    expect(storedSpec(dir, 'retriever_impl').methods[0].symbol).toBe('speak');
    expect(storedSpec(dir, 'dog_impl').methods[0].symbol).toBeUndefined();
    expect(storedSpec(dir, 'animal_impl').methods[0].symbol).toBeUndefined();
    // Asked to pin, every realization is; declined, none is.
    const always = project(tree);
    renameMethod('animal', 'speak', 'bark', true);
    expect(['animal_impl', 'dog_impl', 'retriever_impl'].map((id) => storedSpec(always, id).methods[0].symbol)).toEqual(['speak', 'speak', 'speak']);
    const never = project(tree);
    renameMethod('animal', 'speak', 'bark', false);
    expect(['animal_impl', 'dog_impl', 'retriever_impl'].map((id) => storedSpec(never, id).methods[0].symbol)).toEqual([undefined, undefined, undefined]);
  });

  it('gives the linkage-only implementation of an abstraction an entry pinning the old name, by the same pin rules', () => {
    const tree = zoo();
    tree.files = { 'src/animal.ts': 'export interface Animal { speak(volume: number): void }\n' };
    tree.implementations = tree.implementations!.map((i) => (i.id === 'animal_impl' ? { ...i, sourcePath: 'src/animal.ts', methods: [] } : i));
    const dir = project(tree);
    const dry = renameMethod('animal', 'speak', 'bark', undefined, true);
    expect(dry.pinnedSymbol).toBe('speak');
    expect(dry.renamed).toContain('animal_impl');
    expect(storedSpec(dir, 'animal_impl').methods).toEqual([]);
    const report = renameMethod('animal', 'speak', 'bark');
    expect(report.renamed).toContain('animal_impl');
    expect(storedSpec(dir, 'animal_impl').methods).toEqual([expect.objectContaining({ name: 'bark', symbol: 'speak' })]);
    // No code written: nothing to pin; declined: never.
    const bare = zoo();
    bare.implementations = bare.implementations!.map((i) => (i.id === 'animal_impl' ? { ...i, sourcePath: 'src/animal.ts', methods: [] } : i));
    const none = project(bare);
    renameMethod('animal', 'speak', 'bark');
    expect(storedSpec(none, 'animal_impl').methods).toEqual([]);
    const declined = project(tree);
    renameMethod('animal', 'speak', 'bark', false);
    expect(storedSpec(declined, 'animal_impl').methods).toEqual([]);
  });
});

describe('a rename that cannot follow refuses before the first write, leaving every byte', () => {
  const refuses = (tree: FixtureTree, call: () => unknown, message: RegExp): void => {
    const dir = project(tree);
    const before = snapshot(dir);
    expect(call).toThrow(message);
    expect(snapshot(dir)).toEqual(before);
  };

  it('an implementer that already declares the new name (name-taken), naming it', () => {
    const tree = zoo();
    tree.interfaces = tree.interfaces!.map((i) => (i.id === 'iretriever' ? { ...i, methods: [SPEAK, { ...SPEAK, name: 'bark' }] } : i));
    refuses(tree, () => renameMethod('animal', 'speak', 'bark'), /name-taken: implementer "retriever"/);
    refuses(tree, () => renameMethod('animal', 'speak', 'bark', undefined, true), /name-taken: implementer "retriever"/);
  });

  it('an implementer that retired the new name (name-retired)', () => {
    const tree = zoo();
    tree.interfaces = tree.interfaces!.map((i) => (i.id === 'idog' ? { ...i, methods: [{ ...SPEAK, previousNames: ['idog.bark'] }] } : i));
    refuses(tree, () => renameMethod('animal', 'speak', 'bark'), /name-retired: implementer "dog"/);
  });

  it('an implementer that also implements, outside the chain, an abstraction declaring the old name (follow-conflict)', () => {
    const tree = zoo();
    tree.components!.push({ subsystem: SUB.id, id: 'pet', componentType: 'Orchestrator', abstract: true, description: 'Any pet.' });
    tree.interfaces!.push({ id: 'ipet', component: 'pet', methods: [SPEAK] });
    tree.interfaces = tree.interfaces!.map((i) => (i.id === 'iretriever' ? { ...i, implements: ['dog', 'pet'] } : i));
    refuses(tree, () => renameMethod('animal', 'speak', 'bark'), /follow-conflict: implementer "retriever" also implements "pet"/);
    // The control: a second abstraction that does not declare the name is no conflict.
    const control = zoo();
    control.components!.push({ subsystem: SUB.id, id: 'pet', componentType: 'Orchestrator', abstract: true, description: 'Any pet.' });
    control.interfaces!.push({ id: 'ipet', component: 'pet', methods: [{ ...SPEAK, name: 'adopt' }] });
    control.interfaces = control.interfaces!.map((i) => (i.id === 'iretriever' ? { ...i, implements: ['dog', 'pet'] } : i));
    project(control);
    expect(renameMethod('animal', 'speak', 'bark', undefined, true).followed).toContain('retriever.bark');
  });

  it('an implementer whose subsystem language does not accept the new name (invalid-name)', () => {
    const tree = zoo();
    tree.system = { ...tree.system, targetLanguage: 'typescript' };
    tree.subsystems = [SUB, { id: 'kennel', description: 'The kennel.', targetLanguage: 'rust' }];
    tree.components = tree.components!.map((c) => (c.id === 'retriever' ? { ...c, subsystem: 'kennel' } : c));
    refuses(tree, () => renameMethod('animal', 'speak', 'self'), /invalid-name: .*\(implementer "retriever", subsystem "kennel"\)/);
  });

  it('a rename asked of an implementer for a method its abstraction still declares (declared-above), naming the topmost; the repair is allowed', () => {
    refuses(zoo(), () => renameMethod('retriever', 'speak', 'bark'), /declared-above: "animal" still declares/);
    // A manual edit moved the abstractions to bark and left the implementer behind: renaming it is the repair.
    const dir = project(zoo());
    patch(dir, 'ianimal', (doc) => { doc.methods[0].name = 'bark'; });
    patch(dir, 'idog', (doc) => { doc.methods[0].name = 'bark'; });
    expect(renameMethod('retriever', 'speak', 'bark').followed).toEqual([]);
    expect(storedSpec(dir, 'iretriever').methods[0].name).toBe('bark');
  });

  it('write reach: an implementer in a subsystem the request may not change refuses the whole rename, naming it', () => {
    const tree = zoo();
    tree.subsystems = [SUB, { id: 'kennel', description: 'The kennel.' }];
    tree.components = tree.components!.map((c) => (c.id === 'retriever' ? { ...c, subsystem: 'kennel' } : c));
    const dir = project(tree);
    const before = snapshot(dir);
    const reach = { unwritableRoots: [], subsystems: [{ root: dir, subsystemId: 'kennel', writable: false, decidedBy: 'a test rule' }] };
    expect(() => runWithProjectBinding(dir, { topRoot: dir, parentReach: false, writeReach: reach }, () => renameMethod('animal', 'speak', 'bark')))
      .toThrow(/SubsystemWriteDenied[\s\S]*kennel/);
    expect(snapshot(dir)).toEqual(before);
    // The control: the same rename inside a request that may change every subsystem goes through.
    const open = { unwritableRoots: [], subsystems: [] };
    expect(runWithProjectBinding(dir, { topRoot: dir, parentReach: false, writeReach: open }, () => renameMethod('animal', 'speak', 'bark')).followed).toContain('retriever.bark');
  });
});

describe('moveContractMethod moves one component and nothing else', () => {
  it('writes the component\'s contract and implementation with their trace and leaves implementers and callers alone', () => {
    const dir = project(zoo());
    const move = moveContractMethod('animal', 'speak', 'bark');
    expect(move.renamed).toEqual(['ianimal', 'animal_impl']);
    expect(storedSpec(dir, 'ianimal').methods[0].name).toBe('bark');
    expect(storedSpec(dir, 'idog').methods[0].name).toBe('speak');
    expect(stepsOf(dir, 'keeper_impl', 'feed')[0].targetMethod).toBe('speak');
  });
});

describe('renaming a parameter of an abstraction follows onto its implementers', () => {
  it('renames it where it sits at the same position, names each, and leaves an implementer holding another name alone', () => {
    const tree = zoo();
    tree.interfaces = tree.interfaces!.map((i) => (i.id === 'iretriever' ? { ...i, methods: [{ ...SPEAK, params: [{ name: 'level', type: 'int' }] }] } : i));
    const dir = project(tree);
    const report = renameParam('animal', 'speak', 'volume', 'loudness');
    expect(report.followed).toEqual(['dog.speak']);
    expect(mm(storedSpec(dir, 'ianimal').methods[0].params[0])).toMatchObject({ name: 'loudness', previousNames: ['volume'] });
    expect(mm(storedSpec(dir, 'idog').methods[0].params[0])).toMatchObject({ name: 'loudness', previousNames: ['volume'] });
    expect(storedSpec(dir, 'iretriever').methods[0].params[0].name).toBe('level');
  });

  it('a dry run names the same and writes nothing; nothing implementing the component follows nothing', () => {
    const dir = project(zoo());
    const before = snapshot(dir);
    expect(renameParam('animal', 'speak', 'volume', 'loudness', true).followed).toEqual(['dog.speak', 'retriever.speak']);
    expect(snapshot(dir)).toEqual(before);
    expect(renameParam('retriever', 'speak', 'volume', 'loudness', true).followed).toEqual([]);
  });

  it('refuses before any write when an implementer holds the new name on another parameter (name-taken)', () => {
    const tree = zoo();
    tree.interfaces = tree.interfaces!.map((i) => (i.id === 'idog' ? { ...i, methods: [{ ...SPEAK, params: [{ name: 'volume', type: 'int' }, { name: 'loudness', type: 'int' }] }] } : i));
    const dir = project(tree);
    const before = snapshot(dir);
    expect(() => renameParam('animal', 'speak', 'volume', 'loudness')).toThrow(/name-taken: implementer "dog"/);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('a parameter name an implementer retired', () => {
  it('refuses name-retired naming the implementer, on a dry run and a real rename, leaving every byte', () => {
    const tree = zoo();
    tree.interfaces = tree.interfaces!.map((i) => (i.id === 'idog' ? { ...i, methods: [{ ...SPEAK, params: [{ name: 'volume', type: 'int', previousNames: ['loudness'] }] }] } : i));
    const dir = project(tree);
    const before = snapshot(dir);
    expect(() => renameParam('animal', 'speak', 'volume', 'loudness', true)).toThrow(/name-retired: implementer "dog"/);
    expect(() => renameParam('animal', 'speak', 'volume', 'loudness')).toThrow(/name-retired: implementer "dog"/);
    expect(snapshot(dir)).toEqual(before);
    // The control: a name nobody retired goes through.
    expect(renameParam('animal', 'speak', 'volume', 'gain', true).followed).toEqual(['dog.speak', 'retriever.speak']);
  });
});

describe('a parameter name an implementer cannot take in its own language', () => {
  // The component is written in TypeScript and its implementer, in the kennel subsystem, in Python:
  // a word only Python reserves is a fine parameter on the abstraction and refused on the implementer.
  const mixed = (): FixtureTree => {
    const tree = zoo();
    tree.system = { ...tree.system, targetLanguage: 'typescript' };
    tree.subsystems = [SUB, { id: 'kennel', description: 'The kennel.', targetLanguage: 'python' }];
    tree.components = tree.components!.map((c) => (c.id === 'retriever' ? { ...c, subsystem: 'kennel' } : c));
    return tree;
  };

  it('refuses invalid-name naming the implementer, on a dry run and a real rename, leaving every byte', () => {
    const dir = project(mixed());
    const before = snapshot(dir);
    expect(() => renameParam('animal', 'speak', 'volume', 'lambda', true)).toThrow(/invalid-name: .*implementer "retriever".*subsystem "kennel"/);
    expect(() => renameParam('animal', 'speak', 'volume', 'lambda')).toThrow(/invalid-name: .*implementer "retriever".*subsystem "kennel"/);
    expect(() => planRenameCascade('animal', 'speak', 'lambda', 'volume')).toThrow(/invalid-name: .*implementer "retriever"/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('lets the same name through where every implementer is written in the same language, and another name through here', () => {
    project(mixed());
    expect(renameParam('animal', 'speak', 'volume', 'gain', true).followed).toEqual(['dog.speak', 'retriever.speak']);
    const same = zoo();
    same.system = { ...same.system, targetLanguage: 'typescript' };
    project(same);
    expect(renameParam('animal', 'speak', 'volume', 'lambda', true).followed).toEqual(['dog.speak', 'retriever.speak']);
  });
});

describe('the method casing exemption is for alias::name entries only', () => {
  const tree = (implementsEntries: string[]): FixtureTree => ({
    system: { name: 'Zoo', vision: 'A zoo.', targetLanguage: 'typescript' },
    subsystems: [SUB],
    components: inZoo([
      { id: 'animal', componentType: 'Orchestrator', abstract: true, description: 'Any animal.' },
      { id: 'dog', componentType: 'Orchestrator', description: 'A dog.' },
    ]),
    interfaces: [
      { id: 'ianimal', component: 'animal', methods: [{ ...SPEAK, name: 'howl' }] },
      { id: 'idog', component: 'dog', implements: implementsEntries, methods: [{ ...SPEAK, name: 'howl' }, SPEAK] },
    ],
    implementations: [],
  });

  it('refuses a snake_case name for a component implementing a local abstraction', () => {
    project(tree(['animal']));
    expect(() => renameMethod('dog', 'speak', 'make_noise')).toThrow(/invalid-name: .*method casing/);
  });

  it('accepts it for a component implementing another project\'s extension point', () => {
    const dir = project(tree(['animal', 'pager::notice-sender']));
    renameMethod('dog', 'speak', 'make_noise');
    expect(storedSpec(dir, 'idog').methods.map(mm).map((m: any) => m.name)).toContain('make_noise');
  });
});

describe('the loader and the approval read an implements entry as a component reference', () => {
  it('finds the references of an abstraction through its implements entries (kind implements)', async () => {
    const tree = chain();
    tree.interfaces = tree.interfaces!.map((i) => ({ ...i, name: `Contract ${i.id}`, description: 'Pets and their sounds.' }));
    tree.implementations = [];
    project(tree);
    const { collect } = await import('../../src/core/lookup/reference-finder.js');
    const found = collect('animal');
    expect(found.target).not.toBeNull();
    const hits = found.references.filter((r) => r.kind === 'implements');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('digests a stored string, its list re-save and a one-entry list alike, and two entries apart, over real files', async () => {
    const { captureApprovedSpecs } = await import('../../src/core/approval.js');
    const dir = project(chain({ retrieverImplements: 'dog' }));
    const key = ['.wai', 'specs', 'interfaces', 'iretriever.yaml'].join('/');
    const digestNow = (): string => { invalidateSpecCache(); return captureApprovedSpecs()[key]; };
    const asString = digestNow();
    patch(dir, 'iretriever', (doc) => { doc.implements = ['dog']; });
    expect(digestNow()).toBe(asString);
    patch(dir, 'iretriever', (doc) => { doc.implements = ['dog', 'animal']; });
    expect(digestNow()).not.toBe(asString);
  });

  it('keeps an alias::name entry resolving by its authored text, never binding it to a component key', () => {
    project({
      ...chain(),
      interfaces: [
        { id: 'ianimal', component: 'animal', methods: [SPEAK] },
        { id: 'idog', component: 'dog', implements: ['animal', 'pager::dog'], methods: [SPEAK] },
        { id: 'iretriever', component: 'retriever', implements: 'dog', methods: [SPEAK] },
      ],
    });
    // A component named like the alias entry's tail exists; the entry still reads as authored.
    expect(loadInterfaceSpec('idog')?.implements).toEqual(['animal', 'pager::dog']);
    expect(loadComponentSpecs().some((c) => c.id === 'dog')).toBe(true);
    const graphed = projectFamilyGraph().authoredReferences.filter((r) => r.position === 'implements');
    expect(graphed.map((r) => r.authored)).toEqual(['pager::dog']);
  });
});

describe('the canonical re-save keeps the written form of an implements entry', () => {
  it('a stored string stays a string, a list stays a list, and the entry stays the bare id', async () => {
    const { saveInterfaceSpec, normalizeReferences } = await import('../../src/core/specs.js');
    const dir = project(chain({ retrieverImplements: 'dog' }));
    saveInterfaceSpec(loadInterfaceSpec('iretriever')!);
    expect(storedSpec(dir, 'iretriever').implements).toBe('dog');
    normalizeReferences('interface', 'iretriever');
    expect(storedSpec(dir, 'iretriever').implements).toBe('dog');
    patch(dir, 'idog', (doc) => { doc.implements = ['animal']; });
    saveInterfaceSpec(loadInterfaceSpec('idog')!);
    expect(storedSpec(dir, 'idog').implements).toEqual(['animal']);
  });
});

describe('moving an abstraction to another subsystem', () => {
  const split = (role: boolean): FixtureTree => {
    const tree = chain();
    tree.subsystems = [SUB, { id: 'kennel', description: 'The kennel.', ...(role ? { publicInterfaces: [{ details: 'The animal port', component: 'animal', role: 'implement' }] } : {}) }];
    return tree;
  };

  it('an implements edge across the new boundary needs the abstraction published with role implement', () => {
    const dir = project(split(false));
    const before = snapshot(dir);
    expect(() => moveSpec('component', 'animal', 'kennel')).toThrow(/ABSTRACTION_UNPUBLISHED/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('is allowed once the destination publishes it with role implement, and the entry stays the same id', () => {
    const dir = project(split(true));
    moveSpec('component', 'animal', 'kennel');
    expect(storedSpec(dir, 'idog').implements).toEqual(['animal']);
    expect(storedSpec(dir, 'animal').subsystem).toBe('kennel');
  });
});
