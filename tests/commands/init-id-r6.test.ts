import { describe, it, expect } from 'vitest';
import { initialProjectId } from '../../src/commands/init.js';

// Round 6 (lib-and-app R6-3): `init` in a folder named con / super / aux wrote
// a project.yaml with NO id and said "initialized". A new project now always
// starts with a usable id, and says why it is not the folder name.
describe('initialProjectId (round 6)', () => {
  it('keeps a usable folder name as it is', () => {
    expect(initialProjectId('Order Platform')).toBe('order-platform');
  });
  it('appends -project to a slug the id grammar refuses', () => {
    expect(initialProjectId('con')).toBe('con-project');
    expect(initialProjectId('super')).toBe('super-project');
    expect(initialProjectId('AUX')).toBe('aux-project');
  });
  it('falls back to "project" for a name with no letter or digit', () => {
    expect(initialProjectId('!!!')).toBe('project');
  });
});
