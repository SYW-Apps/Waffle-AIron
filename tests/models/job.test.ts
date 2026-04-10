import { describe, it, expect } from 'vitest';
import { JobSchema, JobResultSchema, generateJobId } from '../../src/models/job.js';

describe('JobSchema', () => {
  it('parses a valid job', () => {
    const raw = {
      id: 'job-20260410-abc1',
      status: 'pending',
      domain: 'core-utils',
      domainPath: 'services/core/packages/core-utils',
      task: 'Fix the JWT expiry bug.',
      createdAt: '2026-04-10T12:00:00.000Z',
    };
    const result = JobSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backend).toBe('claude');
      expect(result.data.context.files).toEqual([]);
    }
  });

  it('defaults context arrays to empty', () => {
    const raw = {
      id: 'job-001',
      domain: 'x',
      domainPath: 'x',
      task: 'do something',
      createdAt: '2026-04-10T12:00:00.000Z',
    };
    const result = JobSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context.files).toEqual([]);
      expect(result.data.context.notes).toEqual([]);
    }
  });
});

describe('JobResultSchema', () => {
  it('parses a valid result', () => {
    const raw = {
      jobId: 'job-001',
      status: 'completed',
      completedAt: '2026-04-10T12:30:00.000Z',
      summary: 'Fixed the bug.',
      filesChanged: ['src/auth/middleware.ts'],
    };
    const result = JobResultSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe('generateJobId', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateJobId()));
    expect(ids.size).toBe(20);
  });

  it('starts with "job-"', () => {
    expect(generateJobId()).toMatch(/^job-/);
  });
});
