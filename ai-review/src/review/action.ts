import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { fetchPullRequest, parsePullRequestNumber } from '../risk/github.ts';
import { runAgent } from './agent.ts';
import { postCheck } from './github.ts';
import { reviewRecord } from './record.ts';
import { renderAgentLog } from './report.ts';
import { runReview, startsOver } from './run.ts';

async function run(): Promise<void> {
    const input = core.getInput('pull-request');
    const eventNumber = context.payload.pull_request?.number;
    if (eventNumber === undefined && input === '') {
        core.setFailed(`ai-review needs a pull_request event or the pull-request input, and got ${context.eventName} without it.`);
        return;
    }
    const number = eventNumber ?? parsePullRequestNumber(input);
    const checksOctokit = getOctokit(core.getInput('github-token', { required: true }));
    const botToken = core.getInput('bot-token');
    const octokit = botToken === '' ? checksOctokit : getOctokit(botToken);
    const fresh = startsOver(context.eventName, core.getInput('start-over'));

    try {
        const outcome = await runReview({
            octokit,
            checksOctokit,
            repo: context.repo,
            number,
            cwd: process.env['GITHUB_WORKSPACE'] ?? process.cwd(),
            fresh,
            awaitRiskTier: context.eventName === 'pull_request',
            publish: true,
            runAgent,
        });
        core.info(`#${number}: ${outcome.kind}`);
        if (outcome.kind === 'reviewed') {
            const agentLog = renderAgentLog(outcome.result.agents);
            core.info(agentLog);
            await core.summary.addRaw(outcome.summary).addCodeBlock(agentLog).write();
            const dir = join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'ai-review-record');
            const path = join(dir, `${number}-round-${outcome.state.round}.json`);
            await mkdir(dir, { recursive: true });
            await writeFile(path, JSON.stringify(reviewRecord(outcome, new Date()), null, 2));
            core.setOutput('record', path);
            core.setOutput('record-name', `ai-review-${number}-round-${outcome.state.round}-${outcome.state.reviewedSha.slice(0, 7)}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pr = await fetchPullRequest(checksOctokit, context.repo, number);
        await postCheck(checksOctokit, context.repo, pr.headSha, 'The review failed', `The AI review did not finish: ${message}`);
        core.setFailed(message);
    }
}

void run();
