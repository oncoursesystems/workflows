import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { assess } from './assess.ts';
import { DEFAULT_POLICY_PATH, fetchPolicy, fetchPullRequest, parsePullRequestNumber, publish } from './github.ts';
import { DEFAULT_JEV_MODEL } from './jev.ts';
import { renderSummary } from './report.ts';

async function run(): Promise<void> {
    const input = core.getInput('pull-request');
    const eventNumber = context.payload.pull_request?.number;
    if (eventNumber === undefined && input === '') {
        core.setFailed(`risk-tier needs a pull_request event or the pull-request input, and got ${context.eventName} without it.`);
        return;
    }
    const number = eventNumber ?? parsePullRequestNumber(input);
    const octokit = getOctokit(core.getInput('github-token', { required: true }));
    const apiKey = core.getInput('typesafe-api-key', { required: true });
    core.setSecret(apiKey);

    const pr = await fetchPullRequest(octokit, context.repo, number);
    if (pr.draft) {
        core.info(`#${number} is a draft, so it is not classified.`);
        return;
    }
    const lookup = await fetchPolicy(octokit, context.repo, pr.baseRef, core.getInput('policy-path') || DEFAULT_POLICY_PATH);
    const classification = await assess(pr, lookup, {
        kind: 'ask',
        options: { apiKey, model: core.getInput('jev-model') || DEFAULT_JEV_MODEL },
    });
    await publish(octokit, context.repo, pr, classification);

    core.setOutput('tier', classification.tier);
    await core.summary.addRaw(renderSummary(classification)).write();
    core.info(`#${number} is ${classification.tier} risk.`);
}

run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
