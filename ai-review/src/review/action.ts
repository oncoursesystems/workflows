import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { fetchPullRequest, parsePullRequestNumber } from '../github/client.ts';
import { runAgent, runAgentWithApiFallback, UsageLimitError } from './agent.ts';
import { postCheck } from './github.ts';
import { reviewRecord } from './record.ts';
import { renderAgentLog } from './report.ts';
import { runReview, startsOver } from './run.ts';
import { ANTHROPIC_AUDIENCE, exchangeIdentityToken, type Federation } from './wif.ts';

function readFederation(): Federation | undefined {
    const federation = {
        ruleId: core.getInput('anthropic-federation-rule-id'),
        organizationId: core.getInput('anthropic-organization-id'),
        serviceAccountId: core.getInput('anthropic-service-account-id'),
        workspaceId: core.getInput('anthropic-workspace-id'),
    };
    return Object.values(federation).every((value) => value !== '') ? federation : undefined;
}

async function apiToken(federation: Federation): Promise<string> {
    const token = await exchangeIdentityToken(federation, await core.getIDToken(ANTHROPIC_AUDIENCE));
    core.setSecret(token);
    core.info('Switched to the Claude API through workload identity federation.');
    return token;
}

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
    const federation = readFederation();
    const apiOnly = core.getInput('api-only') === 'true';
    if (apiOnly && federation === undefined) {
        core.setFailed('api-only needs the anthropic-federation-rule-id, -organization-id, -service-account-id and -workspace-id inputs.');
        return;
    }

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
            runAgent: federation === undefined ? runAgent : runAgentWithApiFallback({ apiOnly, apiToken: () => apiToken(federation) }),
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
        if (error instanceof UsageLimitError) {
            await postCheck(checksOctokit, context.repo, pr.headSha, 'Claude usage limit', `The AI review did not run: ${message}`);
            core.warning(message);
            return;
        }
        await postCheck(checksOctokit, context.repo, pr.headSha, 'The review failed', `The AI review did not finish: ${message}`);
        core.setFailed(message);
    }
}

void run();
