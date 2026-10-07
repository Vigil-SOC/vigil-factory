import { describe, expect, it } from 'vitest';
import { alertKey, claimedBy, describeAdvisory, describeAlert, fixedReports, keysIn, MAX_OPEN_PRS, parseFixReply, parseSeverity, securityQueue, securityStamp, skipReason, type AdvisoryReport, type CodeScanningAlert, type DependabotAlert, type SecurityPr } from '../src/security.ts';
import { factoryComment } from '../src/groom.ts';
import { securityPrompt } from '../src/prompts.ts';

function dep(number: number, over: Partial<DependabotAlert> = {}): DependabotAlert {
  return {
    kind: 'dependabot', number, severity: 'high', url: `https://github.com/o/r/security/dependabot/${number}`,
    ecosystem: 'npm', package: 'axios', manifest: 'clients/web/package-lock.json', scope: 'runtime',
    ghsa: 'GHSA-aaaa-bbbb-cccc', advisory: 'SSRF via absolute URL', vulnerableRange: '< 1.20.0', patched: '1.20.0',
    ...over,
  };
}

function cs(number: number, over: Partial<CodeScanningAlert> = {}): CodeScanningAlert {
  return {
    kind: 'code-scanning', number, severity: 'high', url: `https://github.com/o/r/security/code-scanning/${number}`,
    tool: 'CodeQL', rule: 'py/path-injection', ruleDescription: 'Uncontrolled data used in path expression',
    path: 'core/cases/case_evidence_service.py', line: 42, message: 'This path depends on a\nuser-provided value.',
    ...over,
  };
}

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-02T12:00:00Z');

function pr(n: number, claims: string[], state: SecurityPr['state'] = 'OPEN', mergedHoursAgo?: number): SecurityPr {
  return {
    url: `https://github.com/o/r/pull/${n}`,
    state,
    mergedAt: mergedHoursAgo === undefined ? null : new Date(NOW - mergedHoursAgo * HOUR).toISOString(),
    comments: [{ body: 'looks good' }, { body: factoryComment(`${securityStamp(claims)}\n🏭 fix`) }],
  };
}

const offeredKeys = (alerts: Parameters<typeof securityQueue>[0], prs: SecurityPr[] = [], min: Parameters<typeof securityQueue>[2] = 'high') =>
  securityQueue(alerts, prs, min, NOW).offered.map((o) => alertKey(o.alert));

describe('which alerts a fixer is handed', () => {
  it('those at the threshold or above, most severe first', () => {
    expect(offeredKeys([dep(1, { severity: 'medium' }), dep(2), cs(3, { severity: 'critical' }), dep(4, { severity: 'low' })]))
      .toEqual(['code-scanning#3', 'dependabot#2']);
    expect(offeredKeys([dep(1, { severity: 'medium' }), dep(2, { severity: 'low' })], [], 'medium')).toEqual(['dependabot#1']);
  });

  it('not one an open PR is fixing, or one a human declined by closing its PR', () => {
    expect(offeredKeys([dep(1), dep(2), dep(3)], [pr(10, ['dependabot#1']), pr(11, ['dependabot#2'], 'CLOSED')])).toEqual(['dependabot#3']);
  });

  it('a merge gets a day for GitHub to rescan, then the alert comes back naming it — once', () => {
    expect(offeredKeys([dep(1)], [pr(10, ['dependabot#1'], 'MERGED', 2)])).toEqual([]);
    const { offered } = securityQueue([dep(1)], [pr(10, ['dependabot#1'], 'MERGED', 30)], 'high', NOW);
    expect(offered[0]!.priorAttempts).toEqual(['https://github.com/o/r/pull/10']);
    expect(offeredKeys([dep(1)], [pr(10, ['dependabot#1'], 'MERGED', 60), pr(12, ['dependabot#1'], 'MERGED', 30)])).toEqual([]);
  });

  it('a claim is read from the factory\'s stamp, not from prose', () => {
    expect(claimedBy(pr(1, ['dependabot#1', 'code-scanning#22']))).toEqual(['dependabot#1', 'code-scanning#22']);
    expect(claimedBy({ comments: [{ body: 'this fixes dependabot#1' }] })).toEqual([]);
  });

  it('renders every fact it read, on one line', () => {
    expect(describeAlert(dep(1))).toContain('https://github.com/advisories/GHSA-aaaa-bbbb-cccc');
    expect(describeAlert(cs(3))).toContain('`core/cases/case_evidence_service.py:42`: This path depends on a user-provided value.');
  });
});

describe('when the phase does not run', () => {
  it('off, on a local worker, with too many PRs awaiting a merge, or with nothing due', () => {
    expect(skipReason(false, 'cursor')).toMatch(/disabled/);
    expect(skipReason(true, 'claude-code')).toMatch(/cursor worker/);
    const open = Array.from({ length: MAX_OPEN_PRS }, (_, i) => ({ url: `u${i}` }));
    expect(skipReason(true, 'cursor', open)).toMatch(/awaiting a merge/);
    expect(skipReason(true, 'cursor', [], { offered: 0, held: 4 })).toMatch(/claimed/);
    expect(skipReason(true, 'cursor', [], { offered: 0, held: 0 })).toMatch(/no open alerts/);
    expect(skipReason(true, 'cursor', [], { offered: 2, held: 0 })).toBeNull();
  });

  it('takes "moderate" for medium, and refuses what is not a severity', () => {
    expect(parseSeverity('Moderate')).toBe('medium');
    expect(() => parseSeverity('urgent')).toThrow(/minSeverity/);
  });
});

describe('the fixer\'s reply', () => {
  const offered = ['dependabot#1', 'dependabot#2', 'code-scanning#3', 'code-scanning#4'];

  it('claims the offered alerts its ALERTS lines name, once each', () => {
    const { fixed } = parseFixReply('Done.\nALERTS: dependabot#1, dependabot#2 dependabot#99\nalerts: dependabot#1', offered);
    expect(fixed).toEqual(['dependabot#1', 'dependabot#2']);
  });

  it('dismisses a code scanning finding with its reason, never a dependency alert', () => {
    const { fixed, dismiss } = parseFixReply(
      'ALERTS: code-scanning#3\nFALSE POSITIVE: code-scanning#4 — the path is a constant\nFalse positive: dependabot#2 — unused',
      offered);
    expect(fixed).toEqual(['code-scanning#3']);
    expect(dismiss).toEqual([{ key: 'code-scanning#4', reason: 'the path is a constant' }]);
  });

  it('a finding both fixed and dismissed is dismissed, not claimed', () => {
    const { fixed, dismiss } = parseFixReply('FALSE POSITIVE: code-scanning#3 — test fixture\nALERTS: code-scanning#3 dependabot#1', offered);
    expect(fixed).toEqual(['dependabot#1']);
    expect(dismiss.map((d) => d.key)).toEqual(['code-scanning#3']);
  });

  it('the prompt names the budget and the alerts, and lists the open security PRs', () => {
    const prompt = securityPrompt({ alerts: ['dependabot#1 …'], openPrs: ['https://github.com/o/r/pull/10'], budget: { maxRunMinutes: 90 } });
    expect(prompt).toContain('about 90 minutes');
    expect(prompt).toContain('- dependabot#1 …');
    expect(prompt).toContain('https://github.com/o/r/pull/10');
    expect(prompt).toContain('**Verification**');
  });
});

describe('reported advisories', () => {
  const report = (ghsa: string, over: Partial<AdvisoryReport> = {}): AdvisoryReport => ({
    kind: 'advisory', ghsa, severity: 'high', url: `https://github.com/o/r/security/advisories/${ghsa}`,
    summary: 'Role permissions are not enforced', description: '**Affected:** main\n\nA Viewer can `POST /api/config`.\n\n```\ncurl …\n```',
    cwes: ['CWE-862 Missing Authorization'], reporter: 'CryptoJones', createdAt: '2026-10-03T16:37:18Z', cvss: null, affected: ['<= 0.6'],
    ...over,
  });
  const r1 = report('GHSA-9mxj-c95c-5823');

  it('is named with a prefix, and found in prose, stamps, and replies however it is cased', () => {
    expect(alertKey(r1)).toBe('advisory#GHSA-9mxj-c95c-5823');
    expect(keysIn('fixes advisory#GHSA-9MXJ-C95C-5823 and dependabot#4, not GHSA-aaaa-bbbb-cccc')).toEqual(['advisory#GHSA-9mxj-c95c-5823', 'dependabot#4']);
    expect(claimedBy(pr(1, ['advisory#GHSA-9mxj-c95c-5823']))).toEqual(['advisory#GHSA-9mxj-c95c-5823']);
  });

  it('is offered at any severity, ranked by the reported one, unrated as medium, oldest first', () => {
    const low = report('GHSA-3vfj-56jm-xp4r', { severity: 'low', createdAt: '2026-10-02T20:29:42Z' });
    const unrated = report('GHSA-aaaa-bbbb-cccc', { severity: null, createdAt: '2026-10-01T00:00:00Z' });
    const older = report('GHSA-qxq5-qc4h-2766', { createdAt: '2026-09-28T16:27:25Z' });
    expect(offeredKeys([low, dep(1), r1, unrated, dep(2, { severity: 'critical' }), older]))
      .toEqual(['dependabot#2', 'dependabot#1', 'advisory#GHSA-qxq5-qc4h-2766', 'advisory#GHSA-9mxj-c95c-5823', 'advisory#GHSA-aaaa-bbbb-cccc', 'advisory#GHSA-3vfj-56jm-xp4r']);
  });

  it('is held by any PR that claims it, merged however long ago — GitHub closes no report on a merge', () => {
    expect(offeredKeys([r1], [pr(10, ['advisory#GHSA-9mxj-c95c-5823'])])).toEqual([]);
    expect(offeredKeys([r1], [pr(10, ['advisory#GHSA-9mxj-c95c-5823'], 'MERGED', 60)])).toEqual([]);
    expect(securityQueue([r1], [pr(10, ['advisory#GHSA-9mxj-c95c-5823'], 'CLOSED')], 'high', NOW).held).toBe(1);
  });

  it('reaches the agent whole: the facts on a line, the description quoted', () => {
    const text = describeAdvisory(r1, ['https://github.com/o/r/pull/9']);
    expect(text).toContain('### advisory#GHSA-9mxj-c95c-5823 — Role permissions are not enforced');
    expect(text).toContain('reported **high** by @CryptoJones on 2026-10-03 as CWE-862 Missing Authorization affecting <= 0.6.');
    expect(text).toContain('Still in triage after https://github.com/o/r/pull/9 merged.');
    expect(text).toContain('> A Viewer can `POST /api/config`.\n> \n> ```\n> curl …\n> ```');
    expect(describeAdvisory(report('GHSA-aaaa-bbbb-cccc', { severity: null, reporter: null, cwes: [], affected: [] }))).toContain('reported **unrated** on 2026-10-03.');
  });

  it('the reply closes a report as a false positive, re-rates one, or fixes one — and a re-rating rides along with any of them', () => {
    const offered = ['advisory#GHSA-9mxj-c95c-5823', 'advisory#GHSA-3vfj-56jm-xp4r', 'advisory#GHSA-qxq5-qc4h-2766', 'dependabot#1'];
    const reply = parseFixReply([
      'ALERTS: advisory#GHSA-9mxj-c95c-5823 dependabot#1',
      'FALSE POSITIVE: advisory#GHSA-3vfj-56jm-xp4r — the credentials column is encrypted at rest since #1402',
      'SEVERITY: advisory#GHSA-9mxj-c95c-5823 critical — any signed-in user, no interaction',
      'SEVERITY: advisory#GHSA-qxq5-qc4h-2766 Moderate — needs an operator-configured Elastic source and an analyst role',
      'SEVERITY: advisory#GHSA-qxq5-qc4h-2766 low — repeated, ignored',
      'SEVERITY: advisory#GHSA-zzzz-zzzz-zzzz high — not offered',
      'FALSE POSITIVE: dependabot#1 — never a false positive',
    ].join('\n'), offered);
    expect(reply.fixed).toEqual(['advisory#GHSA-9mxj-c95c-5823', 'dependabot#1']);
    expect(reply.dismiss).toEqual([{ key: 'advisory#GHSA-3vfj-56jm-xp4r', reason: 'the credentials column is encrypted at rest since #1402' }]);
    expect(reply.rerate).toEqual([
      { key: 'advisory#GHSA-9mxj-c95c-5823', severity: 'critical', reason: 'any signed-in user, no interaction' },
      { key: 'advisory#GHSA-qxq5-qc4h-2766', severity: 'medium', reason: 'needs an operator-configured Elastic source and an analyst role' },
    ]);
  });

  it('the prompt carries the reports in their own section with their own rules, and no empty alerts section', () => {
    const prompt = securityPrompt({ alerts: [], advisories: [describeAdvisory(r1)], openPrs: [], budget: { maxRunMinutes: 90 } });
    expect(prompt).toContain('## Reported advisories');
    expect(prompt).toContain('### advisory#GHSA-9mxj-c95c-5823');
    expect(prompt).toContain('SEVERITY: advisory#GHSA-<id>');
    expect(prompt).toContain('FALSE POSITIVE: advisory#GHSA-<id>');
    expect(prompt).not.toContain('## Alerts');
    const alertsOnly = securityPrompt({ alerts: ['dependabot#1 …'], openPrs: [], budget: { maxRunMinutes: 90 } });
    expect(alertsOnly).toContain('## Alerts');
    expect(alertsOnly).not.toContain('Reported advisories');
    expect(alertsOnly).not.toContain('SEVERITY:');
  });

  it('the skip reason says both are empty', () => {
    expect(skipReason(true, 'cursor', [], { offered: 0, held: 0 })).toMatch(/no reports in triage/);
  });
});

describe('fixedReports', () => {
  const accepted = (ghsa: string, description: string) => ({ ghsa, description });
  const pr = (url: string, state: 'OPEN' | 'MERGED' | 'CLOSED') => ({ url, state });
  const fixUrl = 'https://github.com/o/r/pull/1766';
  const acceptedNote = `### Summary\nViewer can write settings.\n\n---\n\n🏭 **Factory assessment**, 2026-10-06.\n\n**Severity high** (reported critical): needs a session.\n\n**Fix in ${fixUrl}.** Accepted as a draft advisory by the software factory, which closes it once the fix merges.\n`;

  it('closes an accepted report once the PR its note names has merged', () => {
    const out = fixedReports([accepted('GHSA-9mxj-c95c-5823', acceptedNote)], [pr(fixUrl, 'MERGED')]);
    expect(out.map((o) => [o.report.ghsa, o.prUrl])).toEqual([['GHSA-9mxj-c95c-5823', fixUrl]]);
  });

  it('waits while the PR is open, and leaves a closed-unmerged PR alone', () => {
    expect(fixedReports([accepted('GHSA-9mxj-c95c-5823', acceptedNote)], [pr(fixUrl, 'OPEN')])).toEqual([]);
    expect(fixedReports([accepted('GHSA-9mxj-c95c-5823', acceptedNote)], [pr(fixUrl, 'CLOSED')])).toEqual([]);
  });

  it('never touches a draft a maintainer wrote themselves', () => {
    const human = accepted('GHSA-jrm2-wc9j-wwcj', `### Summary\nAdmin routes check sign-in only. Fixed in ${fixUrl} I think.`);
    expect(fixedReports([human], [pr(fixUrl, 'MERGED')])).toEqual([]);
  });

  it('leaves a report a human reopened after the factory closed it', () => {
    const reopened = accepted('GHSA-9mxj-c95c-5823', `${acceptedNote}\n---\n\n🏭 **Closed by the software factory**, 2026-10-07: the fix in ${fixUrl} merged. A maintainer can reopen it.\n`);
    expect(fixedReports([reopened], [pr(fixUrl, 'MERGED')])).toEqual([]);
  });

  it('takes the latest acceptance when a report was accepted twice', () => {
    const again = accepted('GHSA-9mxj-c95c-5823', `${acceptedNote}\n---\n\n🏭 **Closed by the software factory**, 2026-10-07: the fix in ${fixUrl} merged.\n\n---\n\n🏭 **Factory assessment**, 2026-10-08.\n\n**Fix in https://github.com/o/r/pull/1900.** Accepted as a draft advisory by the software factory, which closes it once the fix merges.\n`);
    expect(fixedReports([again], [pr(fixUrl, 'MERGED'), pr('https://github.com/o/r/pull/1900', 'OPEN')])).toEqual([]);
    expect(fixedReports([again], [pr('https://github.com/o/r/pull/1900', 'MERGED')]).map((o) => o.prUrl)).toEqual(['https://github.com/o/r/pull/1900']);
  });
});
