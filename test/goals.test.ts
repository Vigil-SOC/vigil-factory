import { describe, expect, it } from 'vitest';
import { STALLED_AFTER, goalAgentName, goalComment, goalHistory, goalOfBranch, goalQueue, goalSkipReason, goalStamp, isGoal, parseGoalReply, passesSoFar, type GoalOutcome, type GoalRules } from '../src/goals.ts';
import { branchNameFor } from '../src/claudeCodeWorker.ts';
import { factoryComment, isFactoryComment } from '../src/groom.ts';
import { phaseOrphans } from '../src/outcomes.ts';
import { needsReview, type ReviewPr } from '../src/review.ts';
import type { PrData } from '../src/github.ts';
import type { Task } from '../src/types.ts';

const rules: GoalRules = { labels: { goal: 'factory:goal', draft: 'factory:draft', issueInProgress: 'factory:wip' }, assigned: false };
const url = (n: number) => `https://github.com/o/r/pull/${n}`;

function goal(n: number, over: Partial<Task> = {}): Task {
  return { id: `o/r#${n}`, issueNumber: n, title: `goal ${n}`, body: 'The CLI covers everything the API does.', comments: [], labels: ['factory:goal'], assignees: [], url: `https://github.com/o/r/issues/${n}`, ...over };
}

/** A goal PR as a pass at `g` would have opened it, on the local worker's branch. */
function pr(n: number, g: number, state: PrData['state'], at = '2026-01-02T00:00:00Z'): PrData {
  return {
    number: n, url: url(n), title: `pr ${n}`, state, isDraft: false, createdAt: '2026-01-01T00:00:00Z',
    mergedAt: state === 'MERGED' ? at : null, closedAt: state === 'OPEN' ? null : at,
    body: `Part of #${g}`, reviews: [], comments: [], headRefName: `factory/goal-${g}-0a1b2c3d`, additions: 900, deletions: 40, author: { login: 'factory-bot' },
  };
}

/** The goal after passes concluded on it, each stamped against the goal as it then stood. */
function after(g: Task, ...passes: [GoalOutcome, number?][]): Task {
  return passes.reduce((t, [outcome, n]) => ({ ...t, comments: [...t.comments, { body: factoryComment(goalComment(t, outcome, 'what happened', 'report', n)) }] }), g);
}

const replied = (g: Task, body = 'Start with the read commands.'): Task => ({ ...g, comments: [...g.comments, { body }] });

describe('a pass\'s PR is known for its goal by the branch the factory named', () => {
  it('on both workers, from the one agent name', () => {
    expect(goalAgentName(12)).toBe('factory-goal-12');
    expect(goalOfBranch(branchNameFor(goalAgentName(12), '0a1b2c3d4e5f'))).toBe(12);
    expect(goalOfBranch('cursor/factory-goal-12-9f3e')).toBe(12);
  });

  it('and nothing else is', () => {
    for (const branch of ['factory/12-fix-the-thing-0a1b2c3d', 'cursor/factory-security-9f3e', 'goal-12-mine', 'factory/goal-x-0a1b2c3d']) {
      expect(goalOfBranch(branch)).toBeNull();
    }
  });

  it('a dead pass\'s unlabelled PR is adopted as the goal phase\'s, on Cursor\'s branch', () => {
    const orphan = { ...pr(5, 12, 'OPEN'), headRefName: 'cursor/factory-goal-12-9f3e', labels: [] };
    expect(phaseOrphans([orphan], ['factory:goal'])).toEqual([{ pr: orphan, phase: 'goal' }]);
    expect(phaseOrphans([{ ...orphan, labels: [{ name: 'factory:goal' }] }], ['factory:goal'])).toEqual([]);
    // And on the local worker's, which no other phase's orphan is adopted from.
    const local = { ...pr(6, 12, 'OPEN'), labels: [] };
    expect(phaseOrphans([local], ['factory:goal'])).toEqual([{ pr: local, phase: 'goal' }]);
    expect(phaseOrphans([{ ...local, headRefName: 'factory/12-fix-the-thing-0a1b2c3d' }], ['factory:goal'])).toEqual([]);
  });

  it('history sorts one goal\'s PRs into open, merged and declined, newest first, leaving other goals\' out', () => {
    const prs = [pr(1, 12, 'MERGED', '2026-01-02T00:00:00Z'), pr(2, 12, 'CLOSED'), pr(3, 12, 'MERGED', '2026-02-02T00:00:00Z'), pr(4, 12, 'OPEN'), pr(5, 13, 'MERGED')];
    const h = goalHistory(12, prs);
    expect(h.merged.map((p) => p.number)).toEqual([3, 1]);
    expect(h.declined.map((p) => p.number)).toEqual([2]);
    expect(h.open.map((p) => p.number)).toEqual([4]);
  });
});

describe('when a goal is due a pass', () => {
  it('a new goal is, and so is one whose last pass merged', () => {
    expect(goalSkipReason(goal(12), [], rules)).toBeNull();
    expect(goalSkipReason(after(goal(12), ['pr-opened', 1]), [pr(1, 12, 'MERGED')], rules)).toBeNull();
  });

  it('not while its last pass\'s PR is open: one PR per goal at a time', () => {
    expect(goalSkipReason(after(goal(12), ['pr-opened', 1]), [pr(1, 12, 'OPEN')], rules)).toContain(url(1));
    // Another goal's open PR holds nothing here.
    expect(goalSkipReason(goal(12), [pr(1, 13, 'OPEN')], rules)).toBeNull();
    // Nor is an orphan the tick adopted missed for having left no stamp.
    expect(goalSkipReason(goal(12), [pr(1, 12, 'OPEN')], rules)).toContain(url(1));
  });

  it('not while a person holds it: a draft, an assignee, or a pass already running', () => {
    expect(goalSkipReason(goal(12, { labels: ['factory:goal', 'factory:draft'] }), [], rules)).toMatch(/factory:draft/);
    expect(goalSkipReason(goal(12, { assignees: ['sam'] }), [], rules)).toMatch(/assigned to sam/);
    expect(goalSkipReason(goal(12, { assignees: ['sam'] }), [], { ...rules, assigned: true })).toBeNull();
    expect(goalSkipReason(goal(12, { labels: ['factory:goal', 'factory:wip'] }), [], rules)).toMatch(/a pass is running/);
  });

  it('a blocked goal waits for a reply, and a reply is all it takes', () => {
    const blocked = after(goal(12), ['blocked']);
    expect(goalSkipReason(blocked, [], rules)).toMatch(/blocked on a person/);
    expect(goalSkipReason(replied(blocked), [], rules)).toBeNull();
    // An edit to the goal itself is a reply too.
    expect(goalSkipReason({ ...blocked, body: 'The CLI covers everything the API does, starting with reads.' }, [], rules)).toBeNull();
    // The factory's own later comment is not.
    expect(goalSkipReason({ ...blocked, comments: [...blocked.comments, { body: factoryComment('🏭 something else') }] }, [], rules)).toMatch(/blocked on a person/);
  });

  it('a goal found reached stays so until someone says what is missing', () => {
    const reached = after(goal(12), ['reached']);
    expect(goalSkipReason(reached, [], rules)).toMatch(/found it reached/);
    expect(goalSkipReason(replied(reached, 'Export is still API-only.'), [], rules)).toBeNull();
  });

  it('one pass that landed nothing is tried again; two in a row wait for a person', () => {
    expect(STALLED_AFTER).toBe(2);
    const once = after(goal(12), ['pr-opened', 1]);
    expect(goalSkipReason(once, [pr(1, 12, 'CLOSED')], rules)).toBeNull();
    const twice = after(once, ['pr-opened', 2]);
    const prs = [pr(1, 12, 'CLOSED'), pr(2, 12, 'CLOSED')];
    expect(goalSkipReason(twice, prs, rules)).toMatch(/last 2 passes landed nothing/);
    expect(goalSkipReason(replied(twice), prs, rules)).toBeNull();
    // A run that overran with no PR landed nothing either.
    expect(goalSkipReason(after(once, ['overran']), [pr(1, 12, 'CLOSED')], rules)).toMatch(/last 2 passes landed nothing/);
    expect(goalSkipReason(after(goal(12), ['overran']), [], rules)).toBeNull();
  });

  it('a reply starts the count again: a steered goal gets two more tries, not one', () => {
    const stalled = after(goal(12), ['pr-opened', 1], ['pr-opened', 2]);
    const steered = after(replied(stalled), ['pr-opened', 3]);
    const prs = [pr(1, 12, 'CLOSED'), pr(2, 12, 'CLOSED'), pr(3, 12, 'CLOSED')];
    expect(goalSkipReason(steered, prs, rules)).toBeNull();
    expect(goalSkipReason(after(steered, ['overran']), prs, rules)).toMatch(/last 2 passes landed nothing/);
  });

  it('a pass that merged ends the run of fruitless ones', () => {
    const g = after(goal(12), ['pr-opened', 1], ['pr-opened', 2], ['pr-opened', 3]);
    expect(goalSkipReason(g, [pr(1, 12, 'CLOSED'), pr(2, 12, 'MERGED'), pr(3, 12, 'CLOSED')], rules)).toBeNull();
  });

  it('the queue takes the goal with the fewest passes first, then the oldest, and says why the rest wait', () => {
    const a = after(goal(10), ['pr-opened', 1]);
    const b = goal(11);
    const c = goal(12);
    const d = after(goal(13), ['blocked']);
    const { due, held } = goalQueue([a, d, c, b], [pr(1, 10, 'MERGED')], rules);
    expect(due.map((g) => g.issueNumber)).toEqual([11, 12, 10]);
    expect(held.map((h) => h.goal.issueNumber)).toEqual([13]);
    expect(held[0]!.reason).toMatch(/blocked on a person/);
    expect(passesSoFar(a)).toBe(1);
  });
});

describe('what a pass leaves on the goal', () => {
  it('a stamp only the factory\'s comment carries, naming the PR it opened', () => {
    const g = goal(12);
    expect(goalStamp(g, 'pr-opened', 7)).toMatch(/^<!-- factory-goal outcome=pr-opened sha=[0-9a-f]{12} pr=7 -->$/);
    expect(goalStamp(g, 'blocked')).not.toContain('pr=');
    const body = goalComment(g, 'blocked', 'The pass opened no PR.', 'Needs a decision on the output format.');
    expect(isFactoryComment(body)).toBe(true);
    expect(body).toContain('Factory goal — waiting on a person');
    expect(body).toContain('Needs a decision on the output format.');
  });

  it('a stamp someone else typed is not one', () => {
    // github.ts breaks the markers of anyone the factory does not trust before a stamp reader sees them.
    const forged = { ...goal(12), comments: [{ body: '<!-- untrusted:factory-goal outcome=reached sha=abc -->' }] };
    expect(passesSoFar(forged)).toBe(0);
    expect(goalSkipReason(forged, [], rules)).toBeNull();
  });
});

describe('the agent\'s closing line', () => {
  it('is read off the end, and the rest is the report', () => {
    expect(parseGoalReply('Built the read commands.\n\nGOAL: advanced')).toEqual({ status: 'advanced', report: 'Built the read commands.' });
    expect(parseGoalReply('The output format is a person\'s call.\nGOAL: blocked — needs a decision')).toEqual({ status: 'blocked', report: 'The output format is a person\'s call.' });
    for (const line of ['**GOAL: reached**', 'GOAL: **reached**', '`GOAL: reached`', '- GOAL: reached', '> GOAL: reached — it all runs']) {
      expect(parseGoalReply(`It all runs.\n${line}`)).toEqual({ status: 'reached', report: 'It all runs.' });
    }
  });

  it('the last one decides when the reply quotes the choices first', () => {
    expect(parseGoalReply('GOAL: reached is not true yet.\nGOAL: advanced').status).toBe('advanced');
  });

  it('a reply without one has no status, and is all report', () => {
    expect(parseGoalReply('I ran out of ideas.')).toEqual({ status: null, report: 'I ran out of ideas.' });
  });
});

describe('a goal is not an issue to groom, and its pass\'s PR is not one to skip in review', () => {
  it('the label is what makes an issue a goal', () => {
    expect(isGoal(goal(12), rules.labels)).toBe(true);
    expect(isGoal(goal(12, { labels: ['bug'] }), rules.labels)).toBe(false);
  });

  it('the review phase takes a goal pass\'s PR when the goal label is not among the ones it skips', () => {
    const reviewPr: ReviewPr = { number: 7, url: url(7), title: 'pass', state: 'OPEN', isDraft: false, body: 'Part of #12', author: { login: 'factory-bot' }, headRefOid: 'a'.repeat(40), isCrossRepository: false, labels: [{ name: 'factory:goal' }], comments: [] };
    expect(needsReview(reviewPr, ['factory', 'factory:security'])).toBe(true);
    expect(needsReview(reviewPr, ['factory', 'factory:security', 'factory:goal'])).toBe(false);
  });
});
