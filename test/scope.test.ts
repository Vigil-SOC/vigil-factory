import { describe, expect, it } from 'vitest';
import { admissible, candidateTasks } from '../src/controller.ts';
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

// `--local` is someone building their own issue on their own machine, so their
// assignment does not stop it; without --local an assignee is a stop sign.
describe('run --issue N --local', () => {
  const assigned = { ...task(4), assignees: ['someone'] };
  const ctx = (local: boolean) => ({
    config: { labels: { issueInProgress: 'factory:wip', epic: 'type:epic' }, assignedIssues: { groom: true, implement: false } },
    ...(local ? { local: true } : {}),
  }) as unknown as Parameters<typeof admissible>[0];

  it('may implement an issue assigned to the person running it', () => {
    expect(admissible(ctx(true), [assigned], 'implement')).toHaveLength(1);
  });

  it('leaves an assigned issue alone otherwise', () => {
    expect(admissible(ctx(false), [assigned], 'implement')).toHaveLength(0);
  });
});
