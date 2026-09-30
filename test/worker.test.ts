import { describe, expect, it } from 'vitest';
import { peakContextEstimate } from '../src/worker.ts';

const run = { inputTokens: 88, outputTokens: 15_771, cacheWriteTokens: 57_132, cacheReadTokens: 2_886_816, totalTokens: 2_959_807 };

describe('peakContextEstimate', () => {
  it('reads peak context from what entered it: uncached input plus cache writes', () => {
    expect(peakContextEstimate({ id: 'claude-opus-5-5', params: { context: '300k' } }, run)).toBe(61_527);
  });

  it('gives no estimate where the cache accounting does not support one', () => {
    expect(peakContextEstimate({ id: 'grok-4.7' }, run)).toBeUndefined();
    expect(peakContextEstimate(null, run)).toBeUndefined();
  });
});
