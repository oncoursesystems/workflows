import { describe, expect, it } from 'vitest';
import { classify } from './classify.ts';
import type { JevResult, JevVerdict } from './jev.ts';
import type { Policy, PolicyLookup } from './policy.ts';
import type { ChangedFile, PullRequest } from './pull-request.ts';

const file = (path: string, lines = 10, extra: Partial<ChangedFile> = {}): ChangedFile => ({
    path,
    status: 'modified',
    additions: lines,
    deletions: 0,
    ...extra,
});

const pr = (files: ChangedFile[]): PullRequest => ({
    repo: 'example-org/example-repo',
    number: 1,
    title: 'A change',
    body: '',
    author: 'someone',
    baseRef: 'master',
    headSha: 'abc',
    draft: false,
    files,
});

const policy = (overrides: Partial<Policy> = {}): PolicyLookup => ({
    kind: 'found',
    policy: {
        minimumRisk: {
            high: ['src/Auth/**', '.github/workflows/**'],
            medium: ['src/Data/**'],
        },
        lowMaxChangedLines: 400,
        ignore: ['**/ext/**', '**/package-lock.json'],
        sensitiveAreas: [],
        ...overrides,
    },
});

const verdict = (overrides: Partial<JevVerdict> = {}): JevVerdict => ({
    model: 'jev-1.14.0',
    tier: 'low',
    tierProbabilities: { low: 0.9, medium: 0.08, high: 0.02 },
    accessChange: 0.1,
    sensitiveArea: 0.1,
    inputTokens: 1000,
    diff: 'complete',
    ...overrides,
});

const answered = (overrides: Partial<JevVerdict> = {}): JevResult => ({ status: 'answered', verdict: verdict(overrides) });
const skipped: JevResult = { status: 'skipped' };

describe('classify', () => {
    it('stays low when no rule fires', () => {
        const result = classify(pr([file('docs/readme.md')]), policy(), answered());
        expect(result.tier).toBe('low');
        expect(result.reasons.filter((r) => r.tier !== 'low')).toEqual([]);
    });

    it('matches a minimum-risk glob through the previous path of a rename', () => {
        const renamed = file('src/Moved/Login.cs', 2, {
            status: 'renamed',
            previousPath: 'src/Auth/Login.cs',
        });
        const result = classify(pr([renamed]), policy(), skipped);
        expect(result.tier).toBe('high');
        expect(result.reasons).toContainEqual({
            source: 'policy',
            tier: 'high',
            text: '`src/Moved/Login.cs` matches `src/Auth/**`.',
        });
    });

    it('matches dot directories', () => {
        const result = classify(pr([file('.github/workflows/ci.yml')]), policy(), skipped);
        expect(result.tier).toBe('high');
    });

    it('collapses many matching files into one reason per pattern', () => {
        const files = Array.from({ length: 300 }, (_, i) => file(`src/Data/Repo${i}.cs`, 1));
        const result = classify(pr(files), policy(), skipped);
        const policyReasons = result.reasons.filter((r) => r.source === 'policy');
        expect(policyReasons).toEqual([
            {
                source: 'policy',
                tier: 'medium',
                text: '`src/Data/Repo0.cs` and 299 more files match `src/Data/**`.',
            },
        ]);
    });

    it('excludes ignored files from the changed-line count', () => {
        const files = [file('src/Web.UI/Content/oncourse/ext/ext-all.js', 5000), file('package-lock.json', 3000), file('app.js', 50)];
        const result = classify(pr(files), policy(), skipped);
        expect(result.countedLines).toBe(50);
        expect(result.tier).toBe('low');
        expect(result.reasons.some((r) => r.source === 'size')).toBe(false);
    });

    it('still applies minimum risk to ignored files', () => {
        const result = classify(
            pr([file('.github/workflows/ext/deploy.yml', 1)]),
            policy({ ignore: ['**/ext/**'] }),
            skipped,
        );
        expect(result.countedLines).toBe(0);
        expect(result.tier).toBe('high');
    });

    it('lifts to medium only above the changed-line limit', () => {
        expect(classify(pr([file('app.js', 400)]), policy(), skipped).tier).toBe('low');
        const over = classify(pr([file('app.js', 401)]), policy(), skipped);
        expect(over.tier).toBe('medium');
        expect(over.reasons).toContainEqual(expect.objectContaining({ source: 'size', tier: 'medium' }));
    });

    it('takes the tier Jev chose', () => {
        const result = classify(
            pr([file('app.js')]),
            policy(),
            answered({ tier: 'medium', tierProbabilities: { low: 0.3, medium: 0.6, high: 0.1 } }),
        );
        expect(result.tier).toBe('medium');
        expect(result.reasons).toContainEqual({ source: 'jev', tier: 'medium', text: 'Jev chose medium (60%).' });
    });

    it('never drops below a policy minimum when Jev says low', () => {
        const result = classify(pr([file('src/Auth/Saml.cs', 1)]), policy(), answered({ tier: 'low' }));
        expect(result.tier).toBe('high');
    });

    it('lifts to high when the access-change flag reaches its threshold', () => {
        const at = classify(pr([file('app.js')]), policy(), answered({ accessChange: 0.5 }));
        expect(at.tier).toBe('high');
        expect(at.reasons).toContainEqual(expect.objectContaining({ source: 'flag', tier: 'high' }));
        const below = classify(pr([file('app.js')]), policy(), answered({ accessChange: 0.49 }));
        expect(below.tier).toBe('low');
    });

    it('lifts a change to a sensitive area to medium even when Jev says low', () => {
        const result = classify(pr([file('app.js')]), policy(), answered({ tier: 'low', sensitiveArea: 0.8 }));
        expect(result.tier).toBe('medium');
        expect(result.reasons).toContainEqual(expect.objectContaining({ source: 'flag', tier: 'medium' }));
    });

    it('stays low when the change does not touch a sensitive area', () => {
        const result = classify(pr([file('app.js')]), policy(), answered({ tier: 'low', sensitiveArea: 0.49 }));
        expect(result.tier).toBe('low');
    });

    it('stays low when the policy names no sensitive areas', () => {
        const result = classify(pr([file('app.js')]), policy(), answered({ tier: 'low', sensitiveArea: null }));
        expect(result.tier).toBe('low');
    });

    it('fails to medium with the error text when Jev failed', () => {
        const result = classify(pr([file('app.js')]), policy(), { status: 'failed', error: 'HTTP 500: boom' });
        expect(result.tier).toBe('medium');
        expect(result.reasons).toContainEqual({
            source: 'fallback',
            tier: 'medium',
            text: 'Jev failed, so a person reviews it: HTTP 500: boom',
        });
    });

    it('adds no Jev reasons when Jev was skipped', () => {
        const result = classify(pr([file('app.js')]), policy(), skipped);
        expect(result.reasons).toEqual([]);
        expect(result.tier).toBe('low');
    });

    it('notes a missing policy and uses the 400-line default', () => {
        const result = classify(pr([file('app.js', 401)]), { kind: 'missing', ref: 'master' }, skipped);
        expect(result.reasons).toContainEqual({ source: 'policy', tier: 'low', text: 'No review policy was found on `master`.' });
        expect(result.tier).toBe('medium');
    });

    it('fails an invalid policy to medium with its error', () => {
        const result = classify(pr([file('app.js')]), { kind: 'invalid', ref: 'master', error: 'ignore: expected array' }, skipped);
        expect(result.tier).toBe('medium');
        expect(result.reasons[0]?.text).toContain('ignore: expected array');
    });

    it('records a truncated or omitted diff', () => {
        expect(classify(pr([file('a')]), policy(), answered({ diff: 'truncated' })).truncatedDiff).toBe(true);
        expect(classify(pr([file('a')]), policy(), answered({ diff: 'omitted' })).truncatedDiff).toBe(true);
        expect(classify(pr([file('a')]), policy(), answered({ diff: 'complete' })).truncatedDiff).toBe(false);
    });
});
