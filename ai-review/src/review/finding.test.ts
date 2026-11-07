import { describe, expect, it } from 'vitest';
import { capSummaryFindings, dedupe, placement, type Candidate, type ReviewedFinding, type Verdict } from './finding.ts';

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
    kind: 'correctness',
    file: 'src/Notes.cs',
    line: 88,
    severity: 'important',
    claim: 'Binds districtId before schoolId',
    failureScenario: 'A teacher loads another school notes',
    ...overrides,
});

const real = (introducedByPullRequest = true, severity: Verdict['severity'] = 'important'): Verdict => ({
    real: true,
    introducedByPullRequest,
    severity,
    reason: 'confirmed',
});
const minor = (): Verdict => real(true, 'minor');
const notReal: Verdict = { real: false, introducedByPullRequest: true, severity: 'important', reason: 'guarded on line 112' };

describe('placement', () => {
    it('posts a finding inline when 2 of 3 reviewers say it is real and important', () => {
        expect(placement([real(), real(), notReal])).toBe('inline');
    });

    it('drops a finding only 1 of 3 reviewers confirm', () => {
        expect(placement([real(), notReal, notReal])).toBe('dropped');
    });

    it('lets the reviewers decide severity, whatever the bug finder said', () => {
        expect(placement([minor(), minor(), real()])).toBe('minor');
        expect(placement([real(), real(), minor()])).toBe('inline');
        expect(placement([real(), minor(), notReal])).toBe('inline');
    });

    it('marks a finding pre-existing when most confirming reviewers say the pull request did not introduce it', () => {
        expect(placement([real(false), real(false), real(true)])).toBe('pre-existing');
        expect(placement([real(false), real(true), notReal])).toBe('inline');
    });
});

describe('capSummaryFindings', () => {
    const reviewed = (placementValue: ReviewedFinding['placement'], line: number): ReviewedFinding => ({
        ...candidate({ line }),
        verdicts: [],
        placement: placementValue,
    });

    it('keeps at most 3 minor and 2 pre-existing findings and never caps inline ones', () => {
        const findings = [
            ...[1, 2, 3, 4].map((line) => reviewed('minor', line)),
            ...[5, 6, 7].map((line) => reviewed('pre-existing', line)),
            ...[8, 9, 10, 11].map((line) => reviewed('inline', line)),
        ];
        const count = (p: ReviewedFinding['placement']) => capSummaryFindings(findings).filter((f) => f.placement === p).length;
        expect([count('minor'), count('pre-existing'), count('inline'), count('dropped')]).toEqual([3, 2, 4, 2]);
    });
});

describe('dedupe', () => {
    it('merges candidates on the same file within 5 lines and keeps the important one', () => {
        const kept = dedupe([
            candidate({ line: 40, severity: 'minor', kind: 'contracts' }),
            candidate({ line: 45, severity: 'important' }),
            candidate({ line: 60 }),
            candidate({ file: 'src/Other.cs', line: 40 }),
        ]);
        expect(kept.map((c) => `${c.file}:${c.line}:${c.severity}`)).toEqual([
            'src/Notes.cs:45:important',
            'src/Notes.cs:60:important',
            'src/Other.cs:40:important',
        ]);
    });
});
