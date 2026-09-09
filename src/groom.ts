// Grooming state lives in the issue itself, not in a local file.
//
// The VERDICT is the `factory:groomed` / `factory:needs-work` label: the thing a
// human already reads and can already change. Nothing parses prose to find it.
//
// What a label cannot carry is *what was groomed*, so the factory's verdict
// comment opens with one invisible line:
//
//   <!-- factory-groom sha=a1b2c3d4e5f6 -->
//   🏭 **Factory groom — groomed.** …
//   …why, in the open, attributed to the factory…
//   ## Factory grooming notes
//   …coding-level direction for the implementer…
//
// `sha` fingerprints the human-authored content — the description plus every
// comment the factory did not write. A mismatch means a human has said something
// since, by editing the description or by replying, so the verdict is void and
// the issue is groomed again. This is the only way to notice an edited
// description without a second API call, since bodies and comments arrive
// together and GitHub's timestamps are bumped by the factory's own labelling.
//
// The two records answer different questions, so they cannot contradict each
// other: the label says whether an issue passed, the fingerprint says whether
// that answer is still about the issue as it stands. The label alone decides
// what may be implemented; the fingerprint only decides what gets looked at
// again. An issue can therefore be both — implementable now, and queued for a
// re-review because someone has since replied to it.
//
// Absence of a fingerprint is not evidence against a verdict, only absence of
// evidence for it: an issue labelled by an older version of the factory, or by
// a human, keeps its verdict and gets re-groomed on a later tick.
//
// One more thing the stamp can carry: `blocked=#N`. A needs-work verdict given
// only because another issue has to land first is about that other issue as
// much as this one, so the stamp names it, and the verdict goes stale the tick
// after #N is no longer open — the same move a human reply makes, without a
// human having to make it.
//
// Epics are groomed by the same machinery with one difference in what
// "groomed" means: not "one PR can land this" but "this direction is settled,
// and its children inherit that". The groomer writes the children, and the
// factory files them under the epic. An epic is never handed to the selector.

import { createHash } from 'node:crypto';
import type { GroomVerdict, IssueComment, Task } from './types.ts';

export const NOTES_HEADING = '## Factory grooming notes';

/** Marks a comment as the factory's own, so the fingerprint can ignore it. */
const FACTORY_MARKER = '<!-- factory-comment -->';
const FACTORY_COMMENT_RE = /<!--\s*factory-/;

/** Migration: verdicts used to be stamped into the description itself. */
const LEGACY_BLOCK_RE =
  /[ \t]*<!--\s*factory-groom:start\b[^>]*-->[\s\S]*?<!--\s*factory-groom:end\s*-->[ \t]*\n?/g;

const STAMP_RE = /<!--\s*factory-groom\s+sha=([0-9a-f]+)(?:\s+blocked=#(\d+))?\s*-->/;

/** The verdict labels, as named in config. */
export interface GroomLabels {
  groomed: string;
  needsWork: string;
  /** The repo's own epic label. An issue carrying it is groomed as direction
   *  and never implemented. Optional so older tests and configs still read. */
  epic?: string;
}

/** An epic: a direction the groomer settles and decomposes, never a PR. */
export function isEpic(task: Task, labels: GroomLabels): boolean {
  return labels.epic !== undefined && task.labels.includes(labels.epic);
}

export type GroomState =
  /** No verdict label: never groomed. */
  | 'ungroomed'
  /** Labelled, but nothing says that verdict is still about this issue. */
  | 'stale'
  /** Labelled, and fingerprinted against the issue as it stands. */
  | 'current';

export function isFactoryComment(body: string): boolean {
  return FACTORY_COMMENT_RE.test(body);
}

/** Wraps a comment the factory writes, so the fingerprint can ignore it. */
export function factoryComment(body: string): string {
  return `${FACTORY_MARKER}\n${body}`;
}

export function hasLegacyBlock(body: string): boolean {
  return body.includes('factory-groom:start');
}

/** The description with any leftover in-body factory block removed. */
export function stripLegacyBlock(body: string): string {
  return body.replace(LEGACY_BLOCK_RE, '');
}

/** Everything a human has said on the issue: the description plus their comments. */
export function humanContent(task: Task): string {
  return [stripLegacyBlock(task.body), ...task.comments.filter((c) => !isFactoryComment(c.body)).map((c) => c.body)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function fingerprint(task: Task): string {
  return createHash('sha256').update(humanContent(task)).digest('hex').slice(0, 12);
}

/** The factory's most recent verdict comment, if it has one. */
function latestGroomComment(task: Task): IssueComment | undefined {
  return [...task.comments].reverse().find((c) => STAMP_RE.test(c.body));
}

/** What the issue looked like when the factory last groomed it. */
export function readFingerprint(task: Task): string | null {
  return latestGroomComment(task)?.body.match(STAMP_RE)?.[1] ?? null;
}

/** The issue the current verdict said had to land first, if it named one. */
export function readBlocker(task: Task): number | null {
  const n = latestGroomComment(task)?.body.match(STAMP_RE)?.[2];
  return n ? Number(n) : null;
}

/** The verdict of record. */
export function verdict(task: Task, labels: GroomLabels): GroomVerdict | null {
  if (task.labels.includes(labels.groomed)) return 'groomed';
  if (task.labels.includes(labels.needsWork)) return 'needs-work';
  return null;
}

/** Every open issue in the repo, claimed or not, by number. */
export type OpenIssues = Map<number, Task>;

export function openIssues(tasks: Task[]): OpenIssues {
  return new Map(tasks.map((t) => [t.issueNumber, t]));
}

/**
 * Whether what a blocked verdict waited for has happened. A sibling has to
 * land, so it clears when it is no longer open. An epic never closes while its
 * children are being built; it clears when it is groomed, because that is the
 * moment its children have a premise.
 */
function blockerCleared(blocker: number, open: OpenIssues, labels: GroomLabels): boolean {
  const target = open.get(blocker);
  if (!target) return true;
  return isEpic(target, labels) && verdict(target, labels) === 'groomed';
}

/**
 * `open` is every open issue in the repo. When given, a verdict blocked on an
 * issue whose blocker has since cleared is stale: what it was waiting for has
 * happened. Left out, blockers are not consulted.
 */
export function groomState(task: Task, labels: GroomLabels, open?: OpenIssues): GroomState {
  if (!verdict(task, labels)) return 'ungroomed';
  if (readFingerprint(task) !== fingerprint(task)) return 'stale';
  const blocker = readBlocker(task);
  if (open && blocker !== null && blockerCleared(blocker, open, labels)) return 'stale';
  return 'current';
}

/** The implementation direction from the current verdict, if it carried any. */
export function groomNotes(task: Task): string | undefined {
  const body = latestGroomComment(task)?.body ?? '';
  const i = body.indexOf(NOTES_HEADING);
  if (i === -1) return undefined;
  return body.slice(i + NOTES_HEADING.length).trim() || undefined;
}

/**
 * The verdict as the factory publishes it: its conclusion and reasoning in the
 * open where the author can argue with it, over a fingerprint of what it read.
 * Additive by construction — a comment cannot overwrite anything a human wrote.
 */
export function groomComment(task: Task, reply: GroomReply, epic = false): string {
  const headline = epic
    ? reply.verdict === 'groomed'
      ? '🏭 **Factory groom — epic groomed.** The direction is settled, with the decisions below as its record; the factory files the first slice of children under it and builds toward it one PR at a time.'
      : '🏭 **Factory groom — epic needs work.** The factory is not building toward this as written; the decision it needs is named below.'
    : reply.verdict === 'groomed'
      ? '🏭 **Factory groom — groomed.** An agent can pick this up as written.'
      : reply.blocked !== undefined
        ? `🏭 **Factory groom — needs work, blocked on #${reply.blocked}.** The factory reviews this again once that issue closes.`
        : '🏭 **Factory groom — needs work.** The factory is not picking this up as written.';
  const stamp = reply.blocked !== undefined && reply.verdict === 'needs-work'
    ? `<!-- factory-groom sha=${fingerprint(task)} blocked=#${reply.blocked} -->`
    : `<!-- factory-groom sha=${fingerprint(task)} -->`;
  const parts = [
    stamp,
    `${headline} Edit the description or reply here and it gets reviewed again on a later tick.`,
    reply.reasoning.trim(),
  ];
  if (reply.notes) parts.push(`${NOTES_HEADING}\n\n${reply.notes.trim()}`);
  return parts.filter(Boolean).join('\n\n');
}

/** The factory's note on an epic naming the children it just filed. */
export function childrenFiledComment(children: { number: number; url: string }[]): string {
  const list = children.map((c) => `- ${c.url}`).join('\n');
  return factoryComment(
    `🏭 **Factory epic — ${children.length} child issue${children.length === 1 ? '' : 's'} filed.** Each is groomed on its own on a later tick, with this epic's decisions as its premise.\n\n${list}`,
  );
}

/**
 * The factory retracting its own groomed verdict after an implementation attempt
 * refuted it. A factory comment, not a groom stamp: the fingerprint keeps
 * pointing at what the groom read, so only a human reply or edit queues a
 * re-groom, and that re-groom reads this report as evidence.
 */
export function failedAttemptComment(report: string): string {
  return factoryComment(
    `🏭 **Factory attempt — needs work.** The factory tried to implement this as groomed and did not land a PR, so it is no longer picking it up as scoped. Edit the description or reply here and it gets groomed again on a later tick, with this attempt in view.\n\n${report.trim()}`,
  );
}

/**
 * Never groomed, or groomed against an issue that has since changed.
 *
 * Newest first. A stale issue's premises are false by construction — the code
 * moved underneath it — so oldest-first spends the grooming budget on the part
 * of the backlog least likely to yield anything buildable, and the factory
 * opens no PRs meanwhile because selection only draws from groomed issues.
 *
 * Epics go ahead of everything, because an epic's verdict is the premise for the
 * issues around it: its children are newer than it by construction, and grooming
 * them first only produces verdicts blocked on it.
 *
 * `force` re-grooms issues whose verdict is still current. The fingerprint covers
 * the issue, not the principles, so editing principles.md or the groom prompt
 * leaves every existing verdict looking valid — this is the way to revisit them.
 */
export function needsGroom(tasks: Task[], labels: GroomLabels, force = false, open?: OpenIssues): Task[] {
  return tasks
    .filter((t) => force || groomState(t, labels, open) !== 'current')
    .sort((a, b) => Number(isEpic(b, labels)) - Number(isEpic(a, labels)) || b.issueNumber - a.issueNumber);
}

/**
 * Passed grooming. The label is the verdict of record and nothing else gates
 * this: a fingerprint that no longer matches queues the issue for another look
 * (see `needsGroom`), it does not retract the verdict the factory already gave.
 *
 * So this is deliberately not the complement of `needsGroom` — an issue can be
 * both implementable and due for a re-review, which is the honest reading of
 * "the verdict stands until something replaces it".
 */
export function isGroomed(task: Task, labels: GroomLabels): boolean {
  return verdict(task, labels) === 'groomed';
}

/** A child issue the groomer wrote for an epic, before it has a number. */
export interface ChildDraft {
  title: string;
  body: string;
}

export interface GroomReply {
  verdict: GroomVerdict;
  notes: string | undefined;
  reasoning: string;
  /** The open issue a needs-work verdict is waiting on, from a `BLOCKED: #N` line. */
  blocked?: number;
  /** Children written for an epic, from fenced ```child blocks. Empty otherwise. */
  children: ChildDraft[];
}

const VERDICT_RE = /^\s*VERDICT:\s*(groomed|needs[-_ ]?work)\s*$/gim;
const BLOCKED_RE = /^\s*BLOCKED:\s*#?(\d+)\s*$/gim;
const NOTES_RE = /```notes[ \t]*\n([\s\S]*?)```/g;
const CHILD_RE = /```child[ \t]*\n([\s\S]*?)```/g;

/** First non-empty line is the title, shorn of markdown; the rest is the body. */
function parseChild(block: string): ChildDraft | null {
  const lines = block.split('\n');
  const i = lines.findIndex((l) => l.trim().length > 0);
  if (i === -1) return null;
  const title = lines[i]!.trim().replace(/^(#+\s*|title:\s*)/i, '').replace(/^\*\*(.*)\*\*$/, '$1').trim();
  const body = lines.slice(i + 1).join('\n').trim();
  return title ? { title, body } : null;
}

/**
 * Parse the groom agent's reply: a trailing verdict line, optionally a
 * `BLOCKED: #N` line, a fenced ```notes block, and for epics any number of
 * fenced ```child blocks. Returns null if there is no verdict to act on — a
 * groom with no verdict is skipped, not guessed at.
 */
export function parseGroomReply(text: string): GroomReply | null {
  const verdicts = [...text.matchAll(VERDICT_RE)];
  const last = verdicts.at(-1);
  if (!last) return null;
  const verdict: GroomVerdict = /^groomed$/i.test(last[1]!) ? 'groomed' : 'needs-work';

  const notes = [...text.matchAll(NOTES_RE)].at(-1)?.[1]?.trim() || undefined;
  const blockedLine = [...text.matchAll(BLOCKED_RE)].at(-1)?.[1];
  const blocked = blockedLine && verdict === 'needs-work' ? Number(blockedLine) : undefined;
  const children = [...text.matchAll(CHILD_RE)]
    .map((m) => parseChild(m[1]!))
    .filter((c): c is ChildDraft => c !== null);

  // The reasoning is everything except the machinery, for the issue comment.
  const reasoning = text
    .replace(NOTES_RE, '')
    .replace(CHILD_RE, '')
    .replace(VERDICT_RE, '')
    .replace(BLOCKED_RE, '')
    .trim();

  return { verdict, notes, reasoning, ...(blocked !== undefined ? { blocked } : {}), children };
}
