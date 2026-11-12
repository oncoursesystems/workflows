import { describe, expect, it } from 'vitest';
import type { Octokit } from '../github/client.ts';
import { waitForRiskTier } from './github.ts';

const checks = (...responses: string[][]) => {
    let call = 0;
    const octokit = {
        rest: {
            checks: {
                listForRef: async () => ({ data: { check_runs: (responses[call++] ?? []).map((status) => ({ status })) } }),
            },
        },
    } as unknown as Octokit;
    return { octokit, calls: () => call };
};

const repo = { owner: 'o', repo: 'r' };

describe('waitForRiskTier', () => {
    it('waits until the risk-tier check on the head commit completes', async () => {
        const fake = checks([], ['in_progress'], ['completed']);
        const slept: number[] = [];
        const settled = await waitForRiskTier(fake.octokit, repo, 'abc', { attempts: 5, intervalMs: 7, sleep: async (ms) => void slept.push(ms) });
        expect(settled).toBe(true);
        expect(fake.calls()).toBe(3);
        expect(slept).toEqual([7, 7]);
    });

    it('gives up after the last attempt', async () => {
        const fake = checks();
        const settled = await waitForRiskTier(fake.octokit, repo, 'abc', { attempts: 3, intervalMs: 1, sleep: async () => {} });
        expect(settled).toBe(false);
        expect(fake.calls()).toBe(3);
    });
});
