import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { fetchPullRequest, parsePullRequestNumber } from '../github/client.ts';
import { DEFAULT_JEV_MODEL } from '../jev/transport.ts';
import { DEFAULT_CONFIG_PATH } from './config.ts';
import { renderSummary } from './report.ts';
import { fetchConfig, labelPullRequest } from './run.ts';

async function run(): Promise<void> {
    const input = core.getInput('pull-request');
    const eventNumber = context.payload.pull_request?.number;
    if (eventNumber === undefined && input === '') {
        core.setFailed(`jev-labeler needs a pull_request event or the pull-request input, and got ${context.eventName} without it.`);
        return;
    }
    const number = eventNumber ?? parsePullRequestNumber(input);
    const octokit = getOctokit(core.getInput('github-token', { required: true }));
    const apiKey = core.getInput('typesafe-api-key', { required: true });
    core.setSecret(apiKey);

    const pr = await fetchPullRequest(octokit, context.repo, number);
    const path = core.getInput('config-path') || DEFAULT_CONFIG_PATH;
    const lookup = await fetchConfig(octokit, context.repo, pr.baseRef, path);
    switch (lookup.kind) {
        case 'missing':
            core.info(`\`${path}\` does not exist on \`${lookup.ref}\`, so #${number} gets no Jev labels.`);
            return;
        case 'invalid':
            core.setFailed(`\`${path}\` on \`${lookup.ref}\` is invalid: ${lookup.error}`);
            return;
        case 'found': {
            const jev = { apiKey, model: core.getInput('jev-model') || DEFAULT_JEV_MODEL };
            const result = await labelPullRequest(octokit, context.repo, pr, lookup.rules, jev, false);
            if (result.status === 'failed') {
                core.setFailed(`Jev failed, so the labels of #${number} are unchanged: ${result.error}`);
                return;
            }
            core.setOutput('labels', result.labelsAfter.join(','));
            await core.summary.addRaw(renderSummary(result)).write();
            core.info(`#${number}: ${result.decisions.map((d) => `${d.rule.name} ${d.action}`).join(', ')}.`);
        }
    }
}

run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
