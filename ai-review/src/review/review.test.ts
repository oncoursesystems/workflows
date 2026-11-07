import { describe, expect, it } from 'vitest';
import type { PullRequest } from '../risk/pull-request.ts';
import type { AgentRequest, AgentRun, RunAgent } from './agent.ts';
import type { Candidate, FinderOutput, Verdict } from './finding.ts';
import { tierFromLabels } from './github.ts';
import { findersFor, MODELS, VERIFIER_MODEL } from './plan.ts';
import { review } from './review.ts';

const pr: PullRequest = {
    repo: 'o/r',
    number: 7,
    title: 'Fix notes',
    body: '',
    author: 'dev',
    baseRef: 'master',
    headSha: 'abc',
    draft: false,
    files: [{ path: 'src/Notes.cs', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+x' }],
};

const candidate = (line: number, claim: string): Candidate => ({
    kind: 'correctness',
    file: 'src/Notes.cs',
    line,
    severity: 'important',
    claim,
    failureScenario: 'wrong notes shown',
});

function fakeAgent(candidates: Candidate[], votesByClaim: Record<string, boolean[]>) {
    const requests: AgentRequest<unknown>[] = [];
    const voteIndex: Record<string, number> = {};
    let running = 0;
    let peak = 0;
    const runAgent: RunAgent = async <T>(request: AgentRequest<T>): Promise<AgentRun<T>> => {
        requests.push(request as AgentRequest<unknown>);
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
        if (request.model !== VERIFIER_MODEL) {
            const output: FinderOutput = { candidates };
            return { output: output as T, costUsd: 1, turns: 3 };
        }
        const claim = candidates.find((c) => request.prompt.includes(c.claim))?.claim ?? '';
        const index = voteIndex[claim] ?? 0;
        voteIndex[claim] = index + 1;
        const verdict: Verdict = { real: votesByClaim[claim]?.[index] ?? false, introducedByPullRequest: true, reason: 'checked' };
        return { output: verdict as T, costUsd: 0.1, turns: 2 };
    };
    return { runAgent, requests, peak: () => peak };
}

const input = { pr, tier: 'medium' as const, files: pr.files, scope: 'the whole pull request', rules: {}, cwd: '.' };

describe('review', () => {
    it('runs the tier finders, sends each candidate to 3 reviewers, and keeps only what 2 of 3 confirm', async () => {
        const agent = fakeAgent([candidate(10, 'confirmed bug'), candidate(50, 'false alarm')], {
            'confirmed bug': [true, true, false],
            'false alarm': [true, false, false],
        });
        const result = await review(input, agent.runAgent);
        const finders = agent.requests.filter((r) => r.model !== VERIFIER_MODEL);
        const verifiers = agent.requests.filter((r) => r.model === VERIFIER_MODEL);
        expect(finders.map((r) => r.model)).toEqual([MODELS.sonnet, MODELS.sonnet, MODELS.sonnet]);
        expect(verifiers).toHaveLength(6);
        expect(result.findings.map((f) => `${f.claim}:${f.placement}`)).toEqual(['confirmed bug:inline', 'false alarm:dropped']);
        expect(result.candidates).toBe(2);
        expect(result.costUsd).toBeCloseTo(3 + 0.6);
    });

    it('never runs more agents at once than the limit', async () => {
        const agent = fakeAgent([candidate(10, 'a'), candidate(30, 'b'), candidate(60, 'c')], {});
        await review({ ...input, tier: 'high' }, agent.runAgent, 2);
        expect(agent.peak()).toBe(2);
    });

    it('gives the verifier the claim but not the finder reasoning or its other candidates', async () => {
        const agent = fakeAgent([candidate(10, 'first claim'), candidate(40, 'second claim')], {});
        await review({ ...input, tier: 'low' }, agent.runAgent);
        const firstVerifier = agent.requests.find((r) => r.model === VERIFIER_MODEL && r.prompt.includes('first claim'));
        expect(firstVerifier?.prompt).not.toContain('second claim');
    });
});

describe('plan', () => {
    it('sizes the bug finders by tier', () => {
        expect(findersFor('low')).toEqual([{ kinds: ['correctness', 'contracts', 'security'], model: MODELS.sonnet }]);
        expect(findersFor('high').map((f) => `${f.kinds.join()}:${f.model}`)).toEqual([
            `correctness:${MODELS.opus}`,
            `contracts:${MODELS.opus}`,
            `security:${MODELS.opus}`,
        ]);
    });

    it('reads the tier from the risk label and falls back to medium', () => {
        expect(tierFromLabels(['bug', 'risk:high'])).toBe('high');
        expect(tierFromLabels(['bug'])).toBe('medium');
    });
});
