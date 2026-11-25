import { describe, expect, it } from 'vitest';
import type { PullRequest } from '../github/pull-request.ts';
import { AgentError, SessionLimitError, type AgentRequest, type AgentRun, type AgentStats, type RunAgent } from './agent.ts';
import { DuplicateGroups, FinderOutput, Verdict, type Candidate } from './finding.ts';
import { tierFromLabels } from './github.ts';
import { findersFor, MERGER_MODEL, MODELS, VERIFIER_MODEL } from './plan.ts';
import { FINDER_RETRY_NOTE, verifierPrompt } from './prompts.ts';
import { review, ReviewFailedError } from './review.ts';

const pr: PullRequest = {
    repo: 'o/r',
    number: 7,
    title: 'Fix notes',
    body: '',
    author: 'dev',
    baseRef: 'master',
    defaultBranch: 'master',
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

type FakeOptions = { finderTools?: Record<string, number>; groups?: DuplicateGroups['groups'] };

function fakeAgent(candidates: Candidate[], votesByClaim: Record<string, boolean[]>, options: FakeOptions = {}) {
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
        const schema: unknown = request.schema;
        if (schema === FinderOutput) {
            const output: FinderOutput = { candidates };
            const tools = options.finderTools ?? { Read: 2 };
            return { output: output as T, stats: { model: request.model, costUsd: 1, turns: 3, durationMs: 5, tools, denied: [], billing: 'subscription' } };
        }
        if (schema === DuplicateGroups) {
            const output: DuplicateGroups = { groups: options.groups ?? [] };
            return { output: output as T, stats: { model: request.model, costUsd: 0.05, turns: 1, durationMs: 2, tools: {}, denied: [], billing: 'subscription' } };
        }
        const claim = candidates.find((c) => request.prompt.includes(c.claim))?.claim ?? '';
        const index = voteIndex[claim] ?? 0;
        voteIndex[claim] = index + 1;
        const verdict: Verdict = {
            real: votesByClaim[claim]?.[index] ?? false,
            introducedByPullRequest: true,
            severity: 'important',
            reason: 'checked',
        };
        return { output: verdict as T, stats: { model: request.model, costUsd: 0.1, turns: 2, durationMs: 3, tools: {}, denied: [], billing: 'subscription' } };
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
        const finders = agent.requests.filter((r) => r.schema === FinderOutput);
        const verifiers = agent.requests.filter((r) => r.schema === Verdict);
        expect(finders.map((r) => r.model)).toEqual([MODELS.sonnet, MODELS.sonnet, MODELS.sonnet]);
        expect(verifiers.map((r) => r.model)).toEqual(Array(6).fill(VERIFIER_MODEL));
        expect(result.findings.map((f) => `${f.claim}:${f.placement}`)).toEqual(['confirmed bug:inline', 'false alarm:dropped']);
        expect(result.candidates).toBe(2);
        expect(result.costUsd).toBeCloseTo(3 + 0.05 + 0.6);
        expect(result.agents.map((agent) => agent.role).filter((role) => role.startsWith('finder'))).toEqual([
            'finder: correctness',
            'finder: contracts',
            'finder: security',
        ]);
        expect(result.agents).toHaveLength(10);
    });

    it('sends only the first of a group of duplicate candidates to the reviewers', async () => {
        const agent = fakeAgent(
            [candidate(42, 'reset throws without a provider'), candidate(77, 'reset calls methods the default provider lacks')],
            { 'reset throws without a provider': [true, true, true] },
            { groups: [{ candidates: [0, 1], fix: 'f' }] },
        );
        const result = await review({ ...input, tier: 'low' }, agent.runAgent);
        const merger = agent.requests.find((r) => r.schema === DuplicateGroups);
        expect(merger?.model).toBe(MERGER_MODEL);
        expect(merger?.prompt).toContain('src/Notes.cs:77');
        expect(agent.requests.filter((r) => r.schema === Verdict).every((r) => r.prompt.includes('reset throws'))).toBe(true);
        expect(result.findings.map((f) => `${f.line}:${f.placement}`)).toEqual(['42:inline']);
        expect(result.candidates).toBe(1);
    });

    it('skips the merger when there is at most one candidate', async () => {
        const agent = fakeAgent([candidate(10, 'only bug')], {});
        await review({ ...input, tier: 'low' }, agent.runAgent);
        expect(agent.requests.some((r) => r.schema === DuplicateGroups)).toBe(false);
    });

    it('never runs more agents at once than the limit', async () => {
        const agent = fakeAgent([candidate(10, 'a'), candidate(30, 'b'), candidate(60, 'c')], {});
        await review({ ...input, tier: 'high' }, agent.runAgent, 2);
        expect(agent.peak()).toBe(2);
    });

    it('gives the verifier the claim but not the finder reasoning or its other candidates', async () => {
        const agent = fakeAgent([candidate(10, 'first claim'), candidate(40, 'second claim')], {});
        await review({ ...input, tier: 'low' }, agent.runAgent);
        const firstVerifier = agent.requests.find((r) => r.schema === Verdict && r.prompt.includes('first claim'));
        expect(firstVerifier?.prompt).not.toContain('second claim');
    });

    it('runs a finder again, once, when it answered without opening a file', async () => {
        const agent = fakeAgent([], {}, { finderTools: { StructuredOutput: 1 } });
        const result = await review({ ...input, tier: 'low' }, agent.runAgent);
        const finders = agent.requests.filter((r) => r.schema === FinderOutput);
        expect(finders).toHaveLength(2);
        expect(finders[0]?.prompt).not.toContain(FINDER_RETRY_NOTE);
        expect(finders[1]?.prompt).toContain(FINDER_RETRY_NOTE);
        expect(result.agents.map((a) => a.role)).toEqual(['finder: correctness, contracts, security', 'finder: correctness, contracts, security (retry)']);
    });

    it('does not run a finder again when it looked at the code with git or Grep instead of Read', async () => {
        const agent = fakeAgent([], {}, { finderTools: { Bash: 4, StructuredOutput: 1 } });
        await review({ ...input, tier: 'low' }, agent.runAgent);
        expect(agent.requests.filter((r) => r.schema === FinderOutput)).toHaveLength(1);
    });

    it('gives the verifier code the pull request removed from other files, after the candidate file', () => {
        const other = { path: 'src/Planner.js', status: 'modified', additions: 0, deletions: 1, patch: '@@ -1 +0,0 @@\n-setProvider(cookies)' };
        const prompt = verifierPrompt(pr, [other, ...pr.files], candidate(1, 'cookies leak'));
        expect(prompt).toContain('-setProvider(cookies)');
        expect(prompt.indexOf('--- src/Notes.cs')).toBeLessThan(prompt.indexOf('--- src/Planner.js'));
    });
});

describe('review when an agent stops early', () => {
    const spent = (costUsd: number, turns: number): AgentStats => ({
        model: MODELS.opus,
        billing: 'subscription',
        costUsd,
        turns,
        durationMs: 1,
        tools: { Read: turns },
        denied: [],
    });

    const failingFirst = (agent: ReturnType<typeof fakeAgent>, schema: unknown, fail: (request: AgentRequest<unknown>) => Promise<never>): RunAgent => {
        let failed = false;
        return async <T>(request: AgentRequest<T>): Promise<AgentRun<T>> => {
            const asked: unknown = request.schema;
            if (asked === schema && !failed) {
                failed = true;
                return fail(request as AgentRequest<unknown>);
            }
            return agent.runAgent(request);
        };
    };

    it('keeps going with the other finders when one runs out of turns, and records what it spent', async () => {
        const agent = fakeAgent([candidate(10, 'confirmed bug')], { 'confirmed bug': [true, true, false] });
        const runAgent = failingFirst(agent, FinderOutput, async () => {
            throw new SessionLimitError('claude-opus-5-5 stopped with error_max_turns: out', spent(7.9, 120), 'turns');
        });
        const result = await review(input, runAgent);
        expect(result.findings.map((f) => [f.claim, f.placement])).toEqual([['confirmed bug', 'inline']]);
        expect(result.agents.find((a) => a.limit !== undefined)).toMatchObject({ role: 'finder: correctness', limit: 'turns', turns: 120, costUsd: 7.9 });
        expect(result.costUsd).toBeGreaterThan(7.9);
    });

    it('counts a reviewer that runs out of turns as a missing vote', async () => {
        const agent = fakeAgent([candidate(10, 'confirmed bug')], { 'confirmed bug': [true, true, true] });
        const runAgent = failingFirst(agent, Verdict, async () => {
            throw new SessionLimitError('claude-haiku-5-5 stopped with error_max_budget_usd: over', spent(1, 9), 'budget');
        });
        const result = await review({ ...input, tier: 'low' }, runAgent);
        expect(result.findings[0]?.verdicts).toHaveLength(2);
        expect(result.findings[0]?.placement).toBe('inline');
        expect(result.agents.filter((a) => a.limit === 'budget').map((a) => a.role)).toEqual(['reviewer: src/Notes.cs:10']);
    });

    it('stops the other agents when one fails, and keeps what the failed agent spent', async () => {
        const siblingsStopped: boolean[] = [];
        let started = 0;
        const runAgent: RunAgent = async <T>(request: AgentRequest<T>): Promise<AgentRun<T>> => {
            const signal = request.signal;
            if (signal === undefined) throw new Error('the review gave the agent no stop signal');
            if (started++ === 0) {
                await new Promise((resolve) => setTimeout(resolve, 5));
                throw new AgentError('claude-opus-5-5 returned output that does not match the schema', spent(0.5, 4));
            }
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            siblingsStopped.push(signal.aborted);
            throw new Error('aborted');
        };
        const error: unknown = await review(input, runAgent).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ReviewFailedError);
        expect(error).toMatchObject({
            message: 'claude-opus-5-5 returned output that does not match the schema',
            agents: [{ role: 'finder: correctness', costUsd: 0.5 }],
        });
        expect(siblingsStopped).toEqual([true, true]);
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
