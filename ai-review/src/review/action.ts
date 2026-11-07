import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { fetchPullRequest, parsePullRequestNumber } from '../risk/github.ts';
import { runAgent } from './agent.ts';
import { postCheck } from './github.ts';
import { runReview } from './run.ts';

const FRESH_EVENTS = new Set(['labeled', 'workflow_dispatch']);

async function run(): Promise<void> {
    const input = core.getInput('pull-request');
    const eventNumber = context.payload.pull_request?.number;
    if (eventNumber === undefined && input === '') {
        core.setFailed(`ai-review needs a pull_request event or the pull-request input, and got ${context.eventName} without it.`);
        return;
    }
    const number = eventNumber ?? parsePullRequestNumber(input);
    const octokit = getOctokit(core.getInput('github-token', { required: true }));
    const fresh = FRESH_EVENTS.has(context.payload.action ?? context.eventName);

    try {
        const outcome = await runReview({
            octokit,
            repo: context.repo,
            number,
            cwd: process.env['GITHUB_WORKSPACE'] ?? process.cwd(),
            fresh,
            publish: true,
            runAgent,
        });
        core.info(`#${number}: ${outcome.kind}`);
        if (outcome.kind === 'reviewed') await core.summary.addRaw(outcome.summary).write();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pr = await fetchPullRequest(octokit, context.repo, number);
        await postCheck(octokit, context.repo, pr.headSha, 'The review failed (trial run)', `The AI review did not finish: ${message}`);
        core.setFailed(message);
    }
}

void run();
