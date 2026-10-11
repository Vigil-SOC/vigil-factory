// The review phase: pull requests the factory did not open.
//
// Contributors, teammates, and other people's coding agents open PRs against
// the target repo, and until now every one of them waited on a human. The
// factory already has what a review needs — the principles grooming judges
// against, and an implementer's standard of verification — so it reviews them
// itself, and it does not hand them back over the fence. One agent per PR reads
// it, decides whether it is worth having, verifies it live if it is, pushes the
// fixes that stand between it and merge to the PR's own branch, and answers
// merge, close, or leave. The controller acts on that answer.
//
// The judgment is the agent's; what the controller enforces is mechanical:
// it merges exactly the commit the agent says it verified, only once CI is
// green on it, never past the repo's own rules (no admin bypass), and never a
// PR that changes `.github/` — workflows run with the repo's secrets, and an
// outside PR is exactly where a change to them should get a human's eyes.
//
// State lives on the PR, the way grooming's lives on the issue. Every review
// ends in a factory comment over one invisible line:
//
//   <!-- factory-review sha=a1b2c3d4e5f6 outcome=merged -->
//
// `sha` fingerprints the PR as it stood when the comment was written: its head
// commit, its description, and every comment the factory did not write. A new
// push, an edited description, or a reply makes the review stale, and the PR is
// reviewed again. `outcome` is what the factory did. A PR it closed is watched
// for one thing: its author replying, which is the invitation the close comment
// makes — the factory reopens it and looks again. A closed PR someone reopened
// is reviewed again whether or not they said anything.
//
// A PR the agent answered merge on and the factory could not merge for a
// mechanical reason — GitHub refused, CI had not finished, no CI reported —
// is stamped `outcome=left verdict=merge`. The review's judgment stands while
// the PR does, so each tick tries the merge again, with no agent, until it
// lands or the PR changes and is reviewed afresh. A human is not the next
// step for a PR the factory already decided to merge. When the merge that was
// refused was a replacement's (below), the stamp names it, `replacement=N`,
// and the retry merges that PR and closes this one as superseded — a
// replacement that conflicts meanwhile is handed back to the agent that opened
// it, like any factory PR (handBackStuckPrs), not left for the babysitter.
//
// The `.github/` rule is about who could already run workflows with the repo's
// secrets. An author with write access to the repo can push a workflow to any
// branch and watch it run; the factory merging their change adds nothing to
// what they can do, so it merges it. Anyone else — a fork contributor with read
// access — gets a human's eyes on it, as the rule has always said.
//
// A PR from a fork is the common case and the awkward one: the agents' machine
// cannot push to a contributor's fork, and Cursor cannot check one out by PR.
// So the agent starts on the default branch and fetches `pull/N/head` itself.
// A fork PR that is right as it stands is merged as it stands. One that needs
// fixes gets them on the agent's own session branch, on top of the author's
// commits; the agent pushes it, and it opens as a replacement PR — the same
// handoff an implementer's PR comes through. The factory merges the replacement, credits
// the author as co-author, and closes the original with a link: `superseded`.

import { createHash } from 'node:crypto';
import { isFactoryComment } from './groom.ts';

export type ReviewVerdict = 'merge' | 'close' | 'leave';
export type ReviewOutcome = 'merged' | 'superseded' | 'closed' | 'left';

/** The slice of a GitHub PR this phase reasons about. */
export interface ReviewPr {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  body: string;
  author: { login: string; name?: string; is_bot?: boolean };
  headRefOid: string;
  /** From a fork: nothing here can push to its branch. */
  isCrossRepository: boolean;
  labels: { name: string }[];
  /** Chronological. */
  comments: { author: { login: string } | null; body: string }[];
}

const STAMP_RE = /<!--\s*factory-review\s+([^>]*?)\s*-->/;

interface ReviewStamp {
  sha: string;
  outcome: ReviewOutcome | null;
  /** The agent answered merge and only a mechanical refusal stood in the way. */
  mergePending: boolean;
  /** The replacement PR the pending merge is of, when the fixes went to one. */
  replacement?: number;
}

function parseStamp(body: string): ReviewStamp | null {
  const m = body.match(STAMP_RE);
  if (!m) return null;
  const attrs = new Map([...m[1]!.matchAll(/(\w+)=(\S+)/g)].map((a) => [a[1]!, a[2]!]));
  const sha = attrs.get('sha');
  if (!sha) return null;
  const outcome = attrs.get('outcome');
  const replacement = Number(attrs.get('replacement'));
  return {
    sha,
    outcome: outcome === 'merged' || outcome === 'superseded' || outcome === 'closed' || outcome === 'left' ? outcome : null,
    mergePending: outcome === 'left' && attrs.get('verdict') === 'merge',
    ...(Number.isInteger(replacement) && replacement > 0 ? { replacement } : {}),
  };
}

/** The index of the factory's latest review comment, or -1. */
function latestStampIndex(pr: ReviewPr): number {
  return pr.comments.map((c) => STAMP_RE.test(c.body)).lastIndexOf(true);
}

export function latestReview(pr: ReviewPr): ReviewStamp | null {
  const i = latestStampIndex(pr);
  return i === -1 ? null : parseStamp(pr.comments[i]!.body);
}

/** The PR as a human left it: head commit, description, and their comments. */
export function reviewFingerprint(pr: Pick<ReviewPr, 'headRefOid' | 'body' | 'comments'>): string {
  const human = pr.comments.filter((c) => !isFactoryComment(c.body)).map((c) => c.body.trim());
  return createHash('sha256').update([pr.headRefOid, pr.body.trim(), ...human].join('\n\n')).digest('hex').slice(0, 12);
}

export function reviewStamp(pr: Pick<ReviewPr, 'headRefOid' | 'body' | 'comments'>, outcome: ReviewOutcome, opts: { mergePending?: boolean; replacement?: number } = {}): string {
  const pending = outcome === 'left' && opts.mergePending === true;
  const verdict = pending ? ' verdict=merge' : '';
  const replacement = pending && opts.replacement ? ` replacement=${opts.replacement}` : '';
  return `<!-- factory-review sha=${reviewFingerprint(pr)} outcome=${outcome}${verdict}${replacement} -->`;
}

/** Bots are someone else's automation: release-please, and Dependabot, whose PRs the dependency batch takes (deps.ts). Not reviewed here. */
export function isBot(pr: Pick<ReviewPr, 'author'>): boolean {
  return pr.author.is_bot === true || pr.author.login.startsWith('app/') || pr.author.login.endsWith('[bot]');
}

/**
 * Whether an open PR is the review phase's to look at now. Not a draft, not the
 * factory's own (its labels say so — the factory opens PRs under a human's
 * account, so the author does not), not a bot's, and either never reviewed, or
 * changed since, or reopened after the factory closed it.
 */
export function needsReview(pr: ReviewPr, factoryLabels: string[]): boolean {
  if (pr.state !== 'OPEN' || pr.isDraft || isBot(pr)) return false;
  if (pr.labels.some((l) => factoryLabels.includes(l.name))) return false;
  const last = latestReview(pr);
  if (!last) return true;
  // Open again after the factory closed it, whoever reopened it.
  if (last.outcome === 'closed' || last.outcome === 'superseded') return true;
  return last.sha !== reviewFingerprint(pr);
}

/**
 * A PR the factory closed whose author has replied since: the close comment
 * invited exactly that, and an author often cannot reopen a PR a maintainer
 * closed. Only the author's reply counts — a maintainer agreeing with the close
 * is not a reason to reopen it.
 */
export function authorReplied(pr: ReviewPr): boolean {
  if (pr.state !== 'CLOSED' || isBot(pr)) return false;
  const i = latestStampIndex(pr);
  if (i === -1 || parseStamp(pr.comments[i]!.body)?.outcome !== 'closed') return false;
  return pr.comments.slice(i + 1).some((c) => c.author?.login === pr.author.login && !isFactoryComment(c.body));
}

/**
 * An open PR whose review answered merge, held back only by something
 * mechanical, and unchanged since: its merge is retried without an agent.
 * A changed PR is not one of these — `needsReview` takes it instead.
 */
export function mergeDue(pr: ReviewPr, factoryLabels: string[]): boolean {
  if (pr.state !== 'OPEN' || pr.isDraft || isBot(pr)) return false;
  if (pr.labels.some((l) => factoryLabels.includes(l.name))) return false;
  const last = latestReview(pr);
  return last !== null && last.mergePending && last.sha === reviewFingerprint(pr);
}

/** Oldest first, the same rule both issue queues follow. */
export function reviewQueue(prs: ReviewPr[], factoryLabels: string[]): { open: ReviewPr[]; reopen: ReviewPr[]; merge: ReviewPr[] } {
  const byNumber = (a: ReviewPr, b: ReviewPr) => a.number - b.number;
  return {
    open: prs.filter((p) => needsReview(p, factoryLabels)).sort(byNumber),
    reopen: prs.filter(authorReplied).sort(byNumber),
    merge: prs.filter((p) => mergeDue(p, factoryLabels)).sort(byNumber),
  };
}

/** A path under `.github/`: workflows, actions, CODEOWNERS, dependabot config. */
export function touchesGithub(files: { path: string }[]): string[] {
  return files.map((f) => f.path).filter((p) => p === '.github' || p.startsWith('.github/'));
}

/**
 * Whether a change under `.github/` from this author is the factory's to merge.
 * `permission` is GitHub's role name for them on the repo. Write and above can
 * already push a workflow to a branch and have it run with the repo's secrets,
 * so a merge adds nothing; read, triage, and no access are the outside PRs the
 * rule exists for.
 */
export function mayMergeGithub(permission: string): boolean {
  return permission === 'write' || permission === 'maintain' || permission === 'admin';
}

export interface ReviewReply {
  verdict: ReviewVerdict;
  /** For `merge`: the head commit the agent verified, as it wrote it (7–40 hex). */
  sha?: string;
  /** Everything else: the factory's comment on the PR. */
  report: string;
}

// The sha may come in backticks, and a gloss may follow it on the line.
const VERDICT_RE = /^\s*VERDICT:\s*(merge|close|leave)\b[ \t`]*([0-9a-f]{7,40}(?![0-9a-z]))?[^\n]*$/gim;

/**
 * The review agent's last VERDICT line. A merge without a commit is not one:
 * the sha is what stops the factory merging something the agent did not see,
 * so it is read as leave.
 */
export function parseReviewReply(text: string): ReviewReply | null {
  const last = [...text.matchAll(VERDICT_RE)].at(-1);
  if (!last) return null;
  const report = text.replace(VERDICT_RE, '').trim();
  const verdict = last[1]!.toLowerCase() as ReviewVerdict;
  const sha = last[2]?.toLowerCase();
  if (verdict === 'merge' && !sha) return { verdict: 'leave', report: `${report}\n\n_(The review answered merge without naming the commit it verified, so the factory did not merge.)_`.trim() };
  return { verdict, ...(verdict === 'merge' && sha ? { sha } : {}), report };
}

/**
 * Whether the commit the agent named is `head`, by its first 7 characters. A
 * model retyping a sha garbles it (#1223 named ca0bf7f0414ad… for
 * ca0bf7f04141d…), so the name only picks which head the agent meant; that the
 * head is the one it saw is the caller's check.
 */
export function sameCommit(named: string, head: string): boolean {
  return named.length >= 7 && head.toLowerCase().startsWith(named.slice(0, 7).toLowerCase());
}

/** The body of the factory's review comment, below the stamp. */
export function reviewComment(outcome: ReviewOutcome, report: string, note?: string, opts: { mergePending?: boolean; replacement?: number } = {}): string {
  const pending = outcome === 'left' && opts.mergePending === true;
  const heading = pending ? '🏭 **Factory review — merge pending.**' : {
    merged: '🏭 **Factory review — merged.**',
    superseded: '🏭 **Factory review — merged with fixes.**',
    closed: '🏭 **Factory review — closed.**',
    left: '🏭 **Factory review — left for a human.**',
  }[outcome];
  const tail = outcome === 'closed'
    ? '\n\nIf this misreads your change, reply here: the factory reopens a PR it closed when its author replies, and reviews it again with your reply in view.'
    : pending
      ? opts.replacement
        ? `\n\nThe factory tries the merge of #${opts.replacement} again every tick, hands it back to its agent if it conflicts or goes red, and closes this PR once it lands. A push or a reply here sends this PR back for a fresh review instead.`
        : '\n\nThe factory tries the merge again every tick while the PR stands as it is. A push or a reply here sends it back for a fresh review instead.'
      : outcome === 'left'
        ? '\n\nPush to the branch or reply here and the factory reviews it again.'
        : '';
  return `${heading}${note ? ` ${note}` : ''}\n\n${report.trim() || '_(no report)_'}${tail}`;
}

/**
 * The trailer that credits a PR's author on the commit that lands their work
 * under someone else's name. GitHub attributes it by the noreply address.
 */
export function coAuthorTrailer(author: { login: string; name?: string }, userId: number): string {
  return `Co-authored-by: ${author.name?.trim() || author.login} <${userId}+${author.login}@users.noreply.github.com>`;
}

/** Why the review phase is not running at all, or null if it may. */
export function skipReason(enabled: boolean, workerKind: string): string | null {
  if (!enabled) return 'review phase is disabled in factory.config.json';
  // A review runs a stranger's code. Cursor's agents do that on a VM that is
  // thrown away; claude-code's would do it on the machine running the tick.
  if (workerKind !== 'cursor') return `reviews of outside PRs run only on the cursor worker (worker.kind is ${workerKind}): they execute the PR's code, and a local agent would execute it on this machine`;
  return null;
}
