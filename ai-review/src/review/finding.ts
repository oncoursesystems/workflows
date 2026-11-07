import { z } from 'zod';

export const BUG_KINDS = ['correctness', 'contracts', 'security'] as const;
export type BugKind = (typeof BUG_KINDS)[number];

export const SEVERITIES = ['important', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const Candidate = z.object({
    kind: z.enum(BUG_KINDS),
    file: z.string().min(1),
    line: z.number().int().positive(),
    severity: z.enum(SEVERITIES),
    claim: z.string().min(1),
    failureScenario: z.string().min(1),
});
export type Candidate = z.infer<typeof Candidate>;

export const FinderOutput = z.object({ candidates: z.array(Candidate) });
export type FinderOutput = z.infer<typeof FinderOutput>;

export const Verdict = z.object({
    real: z.boolean(),
    introducedByPullRequest: z.boolean(),
    severity: z.enum(SEVERITIES),
    reason: z.string().min(1),
});
export type Verdict = z.infer<typeof Verdict>;

export type Placement = 'inline' | 'minor' | 'pre-existing' | 'dropped';
export type ReviewedFinding = Candidate & { verdicts: Verdict[]; placement: Placement };

export const VERIFIERS_PER_CANDIDATE = 3;
export const VOTES_TO_POST = 2;
export const MAX_MINOR = 3;
export const MAX_PRE_EXISTING = 2;

export function placement(verdicts: readonly Verdict[]): Placement {
    const real = verdicts.filter((verdict) => verdict.real);
    if (real.length < VOTES_TO_POST) return 'dropped';
    const preExisting = real.filter((verdict) => !verdict.introducedByPullRequest).length;
    if (preExisting * 2 > real.length) return 'pre-existing';
    const important = real.filter((verdict) => verdict.severity === 'important').length;
    return important * 2 >= real.length ? 'inline' : 'minor';
}

export function capSummaryFindings(findings: readonly ReviewedFinding[]): ReviewedFinding[] {
    const caps: Partial<Record<Placement, number>> = { minor: MAX_MINOR, 'pre-existing': MAX_PRE_EXISTING };
    const used: Partial<Record<Placement, number>> = {};
    return findings.map((finding) => {
        const cap = caps[finding.placement];
        if (cap === undefined) return finding;
        const count = (used[finding.placement] ?? 0) + 1;
        used[finding.placement] = count;
        return count > cap ? { ...finding, placement: 'dropped' } : finding;
    });
}

const LINE_TOLERANCE = 5;

export function dedupe(candidates: readonly Candidate[]): Candidate[] {
    const kept: Candidate[] = [];
    const byPriority = [...candidates].sort((a, b) => Number(b.severity === 'important') - Number(a.severity === 'important'));
    for (const candidate of byPriority) {
        const duplicate = kept.some(
            (other) => other.file === candidate.file && Math.abs(other.line - candidate.line) <= LINE_TOLERANCE,
        );
        if (!duplicate) kept.push(candidate);
    }
    return kept;
}
