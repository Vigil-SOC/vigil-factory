import { describe, expect, it } from 'vitest';
import { candidateTasks } from '../src/controller.ts';
import type { Task } from '../src/types.ts';

const task = (n: number): Task => ({
  id: `acme/widgets#${n}`, issueNumber: n, title: `issue ${n}`, body: '', comments: [], labels: [], assignees: [], url: '',
});

// The scoped context is only what candidateTasks reads.
const ctxWith = (onlyIssue?: number) => ({
  source: { eligibleTasks: async () => [task(1), task(2), task(3)] },
  ...(onlyIssue !== undefined ? { onlyIssue } : {}),
}) as unknown as Parameters<typeof candidateTasks>[0];

// `run --issue N` is a tick that sees one issue: every phase reads the backlog
// through candidateTasks, so nothing else can be groomed or implemented.
describe('run --issue N', () => {
  it('sees only issue N', async () => {
    expect((await candidateTasks(ctxWith(2))).map((t) => t.issueNumber)).toEqual([2]);
  });

  it('sees nothing when N is not an open issue', async () => {
    expect(await candidateTasks(ctxWith(9))).toEqual([]);
  });

  it('sees the whole backlog unscoped', async () => {
    expect((await candidateTasks(ctxWith())).map((t) => t.issueNumber)).toEqual([1, 2, 3]);
  });
});
