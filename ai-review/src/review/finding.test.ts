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

const real = (introducedByPullRequest = true): Verdict => ({ real: true, introducedByPullRequest, reason: 'confirmed' });
const notReal: Verdict = { real: false, introducedByPullRequest: true, reason: 'guarded on line 112' };

describe('placement', () => {
    it('posts an important finding inline when 2 of 3 reviewers say real', () => {
        expect(placement(candidate(), [real(), real(), notReal])).toBe('inline');
    });

    it('drops a finding only 1 of 3 reviewers confirm', () => {
        expect(placement(candidate(), [real(), notReal, notReal])).toBe('dropped');
    });

    it('keeps a confirmed nit out of the inline comments', () => {
        expect(placement(candidate({ severity: 'nit' }), [real(), real(), real()])).toBe('nit');
    });

    it('marks a finding pre-existing when most confirming reviewers say the pull request did not introduce it', () => {
        expect(placement(candidate(), [real(false), real(false), real(true)])).toBe('pre-existing');
        expect(placement(candidate(), [real(false), real(true), notReal])).toBe('inline');
    });
});

describe('capSummaryFindings', () => {
    const reviewed = (placementValue: ReviewedFinding['placement'], line: number): ReviewedFinding => ({
        ...candidate({ line }),
        verdicts: [],
        placement: placementValue,
    });

    it('keeps at most 3 nits and 2 pre-existing findings and never caps inline ones', () => {
        const findings = [
            ...[1, 2, 3, 4].map((line) => reviewed('nit', line)),
            ...[5, 6, 7].map((line) => reviewed('pre-existing', line)),
            ...[8, 9, 10, 11].map((line) => reviewed('inline', line)),
        ];
        const count = (p: ReviewedFinding['placement']) => capSummaryFindings(findings).filter((f) => f.placement === p).length;
        expect([count('nit'), count('pre-existing'), count('inline'), count('dropped')]).toEqual([3, 2, 4, 2]);
    });
});

describe('dedupe', () => {
    it('merges candidates on the same file within 5 lines and keeps the important one', () => {
        const kept = dedupe([
            candidate({ line: 40, severity: 'nit', kind: 'contracts' }),
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
