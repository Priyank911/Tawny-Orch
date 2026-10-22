import { describe, expect, it } from 'vitest';
import { inferRequestedOutputs, validateOutputPath } from '../src/main/orchestrator/outputs';

describe('requested project outputs', () => {
  it('infers a conventional plan file from explicit plan creation language', () => {
    expect(inferRequestedOutputs('Research the harness and create a plan with architecture.')).toEqual(['plan.md']);
    expect(inferRequestedOutputs('Do research, then make a plan + architecture.')).toEqual(['plan.md', 'architecture.md']);
  });

  it('keeps an explicitly named plan.md as one exact deliverable', () => {
    expect(inferRequestedOutputs('Create plan.md with the architecture and rollout steps.')).toEqual(['plan.md']);
  });

  it('does not mistake ordinary planning language for a requested file', () => {
    expect(inferRequestedOutputs('Plan the migration and review the architecture.')).toEqual([]);
  });

  it('rejects traversal and app-private paths', () => {
    expect(validateOutputPath('../plan.md')).toBeUndefined();
    expect(validateOutputPath('.tawny-orch/memory.json')).toBeUndefined();
    expect(validateOutputPath('docs/plan.md')).toBe('docs/plan.md');
  });
});
