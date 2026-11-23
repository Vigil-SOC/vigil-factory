// The goal phase: a direction worked toward one pass at a time, with nothing
// broken down in advance.
//
// An epic settles a direction and writes its children before anything is
// built. That is the right cost for a direction with decisions that bind many
// PRs, and too much ceremony for one that fits in a line: "the CLI covers
// everything the API does", "every screen works on a phone". A goal is that line, on
// an issue carrying the goal label. Each tick one fresh agent reads it, reads
// what earlier passes landed, reads the code as it stands, decides what still
// separates the two, and opens one PR that carries as much of it as one run can
// build and verify. The next pass starts from wherever that one left the code.
// Nobody plans the passes; each is planned by the agent that makes it, against
// what is true by then.
//
// Passes are large on purpose. Most of a run goes to reading the code and
// verifying the change, every pass pays for that again, and a goal has no
// groomer cutting it into slices that share the reading.
//
// No groom stands behind a pass, so two things replace it. The agent is handed
// the principles, because it is choosing what to build. And where the review
// phase runs, the pass's PR is reviewed like anyone's: nobody has yet judged
// whether it is worth having, and that judgment is what a review is. Elsewhere
// it awaits a person. Either way one PR per goal is open at a time, so a goal
// never runs ahead of the verdict on its last pass.
//
// Everything a pass decides from is on GitHub. The goal is an issue: a person
// steers it by replying, pauses it with the draft label or by assigning it,
// and ends it by closing it. A pass's PR is found by the branch its agent was
// started on, which the factory names after the goal. What each pass concluded
// is a stamped comment on the goal, and that is the whole memory: a pass that
// found the goal blocked, or reached, is not repeated until a person says
// something new there.
//
// The brake is one rule. Passes that land nothing — the PR was closed unmerged,
// or the run ended at its budget with no PR — are evidence the goal is not
// one a pass can advance as written, and after two in a row the goal waits for
// a person rather than spend a run every tick finding that out again.

import { fingerprint } from './groom.ts';
import type { Task } from './types.ts';

/** What a pass concluded, as the stamp on the goal records it. A pass that
 *  died of the machine concluded nothing, leaves no stamp, and is retried. */
export type GoalOutcome = 'pr-opened' | 'reached' | 'blocked' | 'overran';

/** Passes in a row that land nothing before a goal waits for a person. */
export const STALLED_AFTER = 2;

const STAMP_RE = /<!--\s*factory-goal\s+([^>]*?)\s*-->/;

interface GoalStamp {
  outcome: GoalOutcome;
  /** The goal as its people had left it when the pass started. */
  sha: string;
  /** The PR the pass opened. */
  pr?: number;
}

function parseStamp(body: string): GoalStamp | null {
  const m = body.match(STAMP_RE);
  if (!m) return null;
  const attrs = new Map([...m[1]!.matchAll(/(\w+)=(\S+)/g)].map((a) => [a[1]!, a[2]!]));
  const outcome = attrs.get('outcome');
  const sha = attrs.get('sha');
  if (!sha || (outcome !== 'pr-opened' && outcome !== 'reached' && outcome !== 'blocked' && outcome !== 'overran')) return null;
  const pr = Number(attrs.get('pr'));
  return { outcome, sha, ...(Number.isInteger(pr) && pr > 0 ? { pr } : {}) };
}

/** Every pass's conclusion on a goal, oldest first. */
function stamps(goal: Task): GoalStamp[] {
  return goal.comments.map((c) => parseStamp(c.body)).filter((s): s is GoalStamp => s !== null);
}

/** How many passes have concluded on a goal. */
export function passesSoFar(goal: Task): number {
  return stamps(goal).length;
}

export function goalStamp(goal: Task, outcome: GoalOutcome, pr?: number): string {
  return `<!-- factory-goal outcome=${outcome} sha=${fingerprint(goal)}${pr ? ` pr=${pr}` : ''} -->`;
}

export function isGoal(task: Task, labels: { goal: string }): boolean {
  return task.labels.includes(labels.goal);
}

/** The name a goal's agent is started under. Both workers name the branch
 *  after it, which is how a pass's PR is known for its goal's. */
export function goalAgentName(goal: number): string {
  return `factory-goal-${goal}`;
}

/** `cursor/factory-goal-12-…` (Cursor) or `factory/goal-12-…` (claude-code) → 12. */
export function goalOfBranch(headRefName: string): number | null {
  const m = headRefName.match(/^(?:cursor\/factory-|factory\/)goal-(\d+)-/);
  return m ? Number(m[1]) : null;
}

interface GoalPr {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  mergedAt: string | null;
  closedAt: string | null;
}

/**
 * What a goal's passes have opened so far: the PR still open, the ones that
 * merged, and the ones closed unmerged, each newest first. The merged are where
 * the next pass starts; the declined are what it must not propose again.
 */
export function goalHistory<P extends GoalPr>(goal: number, prs: P[]): { open: P[]; merged: P[]; declined: P[] } {
  const own = prs.filter((p) => goalOfBranch(p.headRefName) === goal);
  const newest = (a: P, b: P) => (b.mergedAt ?? b.closedAt ?? '').localeCompare(a.mergedAt ?? a.closedAt ?? '') || b.number - a.number;
  return {
    open: own.filter((p) => p.state === 'OPEN'),
    merged: own.filter((p) => p.state === 'MERGED').sort(newest),
    declined: own.filter((p) => p.state === 'CLOSED').sort(newest),
  };
}

/**
 * The latest passes in a row that landed nothing — a PR closed unmerged, or a
 * run that overran with none — since a person last said anything on the goal.
 * A stamp carries the goal's fingerprint as its pass found it, so the passes
 * since the last reply are the ones stamped as the latest is.
 */
function fruitless(goal: Task, prs: GoalPr[]): number {
  const state = new Map(prs.map((p) => [p.number, p.state]));
  const landedNothing = (s: GoalStamp) => s.outcome === 'overran' || (s.outcome === 'pr-opened' && s.pr !== undefined && state.get(s.pr) === 'CLOSED');
  const all = stamps(goal);
  const since = all.at(-1)?.sha;
  let n = 0;
  while (n < all.length && all[all.length - 1 - n]!.sha === since && landedNothing(all[all.length - 1 - n]!)) n += 1;
  return n;
}

export interface GoalRules {
  labels: { goal: string; draft: string; issueInProgress: string };
  /** `assignedIssues.implement`: whether an assignee holds a goal back. */
  assigned: boolean;
}

/**
 * Why no pass runs on a goal now, or null if one should. Kept in one place so
 * the tick, the dry run, and `factory status` give the same answer.
 *
 * A conclusion stands until a person says something new on the goal: the
 * stamp carries the goal's fingerprint, which is its description and every
 * comment the factory did not write. So a reply is how a blocked goal is
 * unblocked, a reached one is taken up again, and a stalled one is steered.
 */
export function goalSkipReason(goal: Task, prs: GoalPr[], rules: GoalRules): string | null {
  const { labels } = rules;
  if (goal.labels.includes(labels.draft)) return `it carries ${labels.draft}`;
  if (!rules.assigned && goal.assignees.length > 0) return `it is assigned to ${goal.assignees.join(', ')}`;
  if (goal.labels.includes(labels.issueInProgress)) return `a pass is running on it, or died holding ${labels.issueInProgress}`;
  const { open } = goalHistory(goal.issueNumber, prs);
  if (open.length > 0) return `its last pass's PR is still open (${open.map((p) => p.url).join(', ')})`;
  const last = stamps(goal).at(-1);
  if (!last || last.sha !== fingerprint(goal)) return null;
  if (last.outcome === 'blocked') return 'its last pass found it blocked on a person, and nobody has replied on the goal since';
  if (last.outcome === 'reached') return 'its last pass found it reached, and nobody has replied on the goal to say what is missing';
  const wasted = fruitless(goal, prs);
  if (wasted >= STALLED_AFTER) return `its last ${wasted} passes landed nothing, and nobody has replied on the goal to steer it`;
  return null;
}

/**
 * The goals a tick takes a pass at, and the ones it leaves with why. The goal
 * with the fewest passes behind it goes first, then the oldest, so several
 * goals share the ticks instead of the first one taking them all.
 */
export function goalQueue<P extends GoalPr>(goals: Task[], prs: P[], rules: GoalRules): { due: Task[]; held: { goal: Task; reason: string }[] } {
  const due: Task[] = [];
  const held: { goal: Task; reason: string }[] = [];
  for (const goal of [...goals].sort((a, b) => passesSoFar(a) - passesSoFar(b) || a.issueNumber - b.issueNumber)) {
    const reason = goalSkipReason(goal, prs, rules);
    if (reason) held.push({ goal, reason });
    else due.push(goal);
  }
  return { due, held };
}

export interface GoalReply {
  /** The agent's closing line; null when it wrote none. */
  status: 'advanced' | 'reached' | 'blocked' | null;
  /** Everything else it wrote: the factory's comment on the goal. */
  report: string;
}

/** The last `GOAL:` line decides; a reply that quotes the choices above its answer still parses. */
export function parseGoalReply(text: string): GoalReply {
  const lines = text.split('\n');
  const at = lines.map((l) => /^[\s>*_`-]*GOAL:[\s*_`]*(advanced|reached|blocked)\b/i.test(l)).lastIndexOf(true);
  if (at === -1) return { status: null, report: text.trim() };
  const status = lines[at]!.match(/GOAL:[\s*_`]*(advanced|reached|blocked)/i)![1]!.toLowerCase() as NonNullable<GoalReply['status']>;
  return { status, report: [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n').trim() };
}

/** The factory's comment on a goal after a pass: the stamp, a heading that says what happened, and the agent's own report. */
export function goalComment(goal: Task, outcome: GoalOutcome, what: string, report: string, pr?: number): string {
  const heading: Record<GoalOutcome, string> = {
    'pr-opened': 'a pass opened a PR',
    reached: 'reached',
    blocked: 'waiting on a person',
    overran: 'a pass ran out of time',
  };
  return `${goalStamp(goal, outcome, pr)}\n🏭 **Factory goal — ${heading[outcome]}.** ${what}${report ? `\n\n${report}` : ''}`;
}
