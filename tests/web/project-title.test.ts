import { describe, it, expect } from 'vitest';
import { devPageTitle, hostedPageTitle, projectLabel } from '../../web/src/views/devCockpitLogic.js';

describe('project title', () => {
  it('prefers the system name, falls back when blank', () => {
    expect(projectLabel('  Billing  ')).toBe('Billing');
    expect(projectLabel('   ')).toBe('project');
    expect(projectLabel(undefined, 'local')).toBe('local');
  });
  it('builds dev and hosted titles', () => {
    expect(devPageTitle('Billing')).toBe('Billing · wairon dev');
    expect(hostedPageTitle('Billing')).toBe('Billing · wairon');
    expect(hostedPageTitle('')).toBe('wairon');
    expect(hostedPageTitle()).toBe('wairon');
  });
});
