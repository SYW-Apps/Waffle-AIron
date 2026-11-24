import { describe, it, expect } from 'vitest';
import { consumerMethodLabels, type ExternalConsumer } from '../../src/models/project-family.js';

const consumer = (uses: ExternalConsumer['uses']): ExternalConsumer => ({
  project: 'app', key: 'app', directory: '/app', alias: 'sdk', section: 'externals', names: [], uses,
});

describe('consumerMethodLabels', () => {
  it('labels a method reached through an implements entry as implemented, the rest as called', () => {
    const labels = consumerMethodLabels(consumer([
      { publicName: 'Hook', kind: 'component', members: ['handle'], implementedMembers: ['handle'] },
      { publicName: 'Client', kind: 'component', members: ['send', 'type'] },
    ]));
    expect(labels.implements).toEqual(['Hook.handle']);
    expect(labels.calls).toEqual(['Client.send']);
  });

  it('leaves calls empty for a consumer that only implements', () => {
    const labels = consumerMethodLabels(consumer([
      { publicName: 'Hook', kind: 'component', members: ['handle'], implementedMembers: ['handle'] },
    ]));
    expect(labels.calls).toEqual([]);
    expect(labels.implements).toEqual(['Hook.handle']);
  });
});
