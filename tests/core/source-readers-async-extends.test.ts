import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import type { ImplementationSpec } from '../../src/models/specs.js';
import type { SourceFileFacts } from '../../src/models/index.js';

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function readClaimed(files: Record<string, string>, claimed: string[], entry: string): SourceFileFacts {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r2a-')));
  temps.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const impls = claimed.map((file, i) => ({ id: `impl-${i}`, contract: 'ia', sourcePath: file, methods: [] })) as unknown as ImplementationSpec[];
  const facts = buildCodeModel(impls, [], root).files.find((f) => f.path === entry);
  if (!facts) throw new Error(`no facts for ${entry}`);
  return facts;
}

describe('cross-file extends', () => {
  const base = 'export interface Carrier { quote(a: string): number; dispatch(b: string): void; track(c: string): string }\n';
  for (const form of ["import type { Carrier } from './carrier.js';", "import { Carrier } from './carrier';", "import { Carrier } from './carrier.js';"]) {
    for (const claimed of [['src/parcel.ts', 'src/carrier.ts'], ['src/parcel.ts']]) {
      it(`reads the inherited members (${form}, ${claimed.length} claimed)`, () => {
        const facts = readClaimed({
          'src/carrier.ts': base,
          'src/parcel.ts': `${form}\nexport interface ParcelCarrier extends Carrier { reroute(d: string): boolean }\n`,
        }, claimed, 'src/parcel.ts');
        expect(Object.keys(facts.typeShapes!.ParcelCarrier.signatures!).sort()).toEqual(['dispatch', 'quote', 'reroute', 'track']);
      });
    }
  }
});

describe('cross-file extends: declared names', () => {
  it('lists the inherited members among the declared names of the file, claimed or not', () => {
    for (const claimed of [['src/parcel.ts', 'src/carrier.ts'], ['src/parcel.ts']]) {
      const facts = readClaimed({
        'src/carrier.ts': 'export interface Carrier { quote(a: string): number; track(c: string): string }\n',
        'src/parcel.ts': "import type { Carrier } from './carrier.js';\nexport interface ParcelCarrier extends Carrier { reroute(d: string): boolean }\n",
      }, claimed, 'src/parcel.ts');
      expect(facts.declaredNames).toEqual(expect.arrayContaining(['quote', 'track', 'reroute']));
      expect(facts.anchoredNames).toEqual(expect.arrayContaining(['quote', 'track']));
    }
  });
});
