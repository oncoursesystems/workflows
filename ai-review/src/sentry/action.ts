import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { DEFAULT_JEV_MODEL } from '../jev/transport.ts';
import { runAgent, runAgentWithApiFallback, type RunAgent } from '../review/agent.ts';
import { ANTHROPIC_AUDIENCE, exchangeIdentityToken, type Federation } from '../review/wif.ts';
import { DEFAULT_CONFIG_PATH } from './config.ts';
import { agentEnv, CLAUDE_AUTH_VARIABLE } from './env.ts';
import { runFixer } from './fixer.ts';
import { defaultBranchHead, requireConfig } from './github.ts';
import { FixResult, parseJson, PlannedIssue, readJson } from './handoff.ts';
import { onMerged } from './merged.ts';
import { plan } from './plan.ts';
import { publish } from './publish.ts';
import { resolveRelease } from './release.ts';
import { renderWalk } from './report.ts';
import type { SentryOptions } from './sentry.ts';

// One entry point, so the composite actions share one install. Each step passes only the secrets its command needs.

const RESULT_FILE = 'result.json';

function sentryOptions(): SentryOptions {
    const token = core.getInput('sentry-token', { required: true });
    core.setSecret(token);
    return { token, org: core.getInput('sentry-org', { required: true }) };
}

const configPath = () => core.getInput('config-path') || DEFAULT_CONFIG_PATH;

async function planCommand(): Promise<void> {
    const octokit = getOctokit(core.getInput('github-token', { required: true }));
    const apiKey = core.getInput('typesafe-api-key', { required: true });
    core.setSecret(apiKey);
    const dryRun = core.getInput('dry-run') === 'true';
    const head = await defaultBranchHead(octokit, context.repo);
    const config = await requireConfig(octokit, context.repo, head.branch, configPath());
    const result = await plan({
        octokit,
        repo: context.repo,
        sentry: sentryOptions(),
        jev: { apiKey, model: core.getInput('jev-model') || DEFAULT_JEV_MODEL },
        config,
        sha: head.sha,
        log: (message) => core.warning(message),
    });
    const table = renderWalk(result, config, dryRun);
    core.info(table);
    await core.summary.addRaw(table).write();
    const planned = dryRun ? [] : result.planned;
    core.setOutput('issues', JSON.stringify(planned));
    core.setOutput('count', String(planned.length));
    core.setOutput('sha', head.sha);
}

function readFederation(): Federation | undefined {
    const federation = {
        ruleId: core.getInput('anthropic-federation-rule-id'),
        organizationId: core.getInput('anthropic-organization-id'),
        serviceAccountId: core.getInput('anthropic-service-account-id'),
        workspaceId: core.getInput('anthropic-workspace-id'),
    };
    return Object.values(federation).every((value) => value !== '') ? federation : undefined;
}

async function fixCommand(): Promise<void> {
    const planned = parseJson(core.getInput('issue', { required: true }), PlannedIssue, 'the issue input');
    const out = core.getInput('out-dir', { required: true });
    const federation = readFederation();
    const minted: string[] = [];
    const agent: RunAgent =
        federation === undefined
            ? runAgent
            : runAgentWithApiFallback({
                  apiOnly: false,
                  apiToken: async () => {
                      const token = await exchangeIdentityToken(federation, await core.getIDToken(ANTHROPIC_AUDIENCE));
                      core.setSecret(token);
                      minted.push(token);
                      core.info('Switched to the Claude API through workload identity federation.');
                      return token;
                  },
              });
    const result = await runFixer({
        planned,
        cwd: process.env['GITHUB_WORKSPACE'] ?? process.cwd(),
        runAgent: agent,
        env: agentEnv(process.env, planned.project.env),
        secrets: () => [process.env[CLAUDE_AUTH_VARIABLE] ?? '', ...minted],
    });
    await mkdir(out, { recursive: true });
    await writeFile(join(out, RESULT_FILE), JSON.stringify(result));
    const { shortId } = planned.context.issue;
    if (result.status === 'failed') {
        core.warning(`${shortId}: the fixer did not finish, so nothing is published for it: ${result.error}`);
        return;
    }
    const verdict = result.gate.open ? 'a pull request' : `a no-fix note (${result.gate.reasons.join(' ')})`;
    core.info(`${shortId}: ${result.output.outcome} at ${result.output.confidence} confidence, for ${verdict}.`);
    core.info(`${result.stats.billing}, $${result.stats.costUsd.toFixed(2)}, ${result.stats.turns} turns. Denied: ${result.stats.denied.join(', ') || 'none'}.`);
}

async function publishCommand(): Promise<void> {
    const octokit = getOctokit(core.getInput('bot-token', { required: true }));
    const sentry = sentryOptions();
    const head = await defaultBranchHead(octokit, context.repo);
    const config = await requireConfig(octokit, context.repo, head.branch, configPath());
    const dir = core.getInput('results-dir', { required: true });
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const lines: string[] = [];
    let failures = 0;
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
        try {
            const result = await readJson(join(dir, entry.name, RESULT_FILE), FixResult);
            const published = await publish(result, { octokit, repo: context.repo, sentry, config, now: new Date() });
            const { shortId } = result.planned.context.issue;
            if (published.kind === 'pr') lines.push(`- ${shortId}: ${published.created ? 'opened' : 'updated'} ${published.url}`);
            else if (published.kind === 'no-fix') lines.push(`- ${shortId}: no confident fix, noted on Sentry. ${published.reasons.join(' ')}`);
            else lines.push(`- ${shortId}: not published, because ${published.reason}`);
        } catch (error) {
            failures++;
            core.error(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const summary = ['## Sentry fix results', '', ...(lines.length === 0 ? ['No fixer results.'] : lines), ''].join('\n');
    core.info(summary);
    await core.summary.addRaw(summary).write();
    if (failures > 0) core.setFailed(`${failures} result(s) failed to publish.`);
}

async function mergedCommand(): Promise<void> {
    const pr = context.payload.pull_request;
    if (pr === undefined) {
        core.setFailed(`sentry-fix-merged needs a pull_request event, and got ${context.eventName}.`);
        return;
    }
    const octokit = getOctokit(core.getInput('github-token', { required: true }));
    const outcome = await onMerged(
        {
            number: pr.number,
            merged: pr['merged'] === true,
            labels: ((pr['labels'] ?? []) as { name: string }[]).map((label) => label.name),
            body: (pr['body'] as string | null | undefined) ?? null,
            url: pr['html_url'] as string,
        },
        octokit,
        context.repo,
        sentryOptions(),
    );
    core.info(outcome.kind === 'marked' ? `#${pr.number} marked as merged for Sentry issue ${outcome.issueId}.` : `#${pr.number} ignored: ${outcome.reason}.`);
}

async function releaseCommand(): Promise<void> {
    const octokit = getOctokit(core.getInput('github-token', { required: true }));
    const head = await defaultBranchHead(octokit, context.repo);
    const config = await requireConfig(octokit, context.repo, head.branch, configPath());
    const { release, outcomes } = await resolveRelease({
        octokit,
        repo: context.repo,
        sentry: sentryOptions(),
        config,
        input: {
            app: core.getInput('app', { required: true }),
            version: core.getInput('version'),
            release: core.getInput('release'),
            tag: core.getInput('tag', { required: true }),
            previousTag: core.getInput('previous-tag', { required: true }),
        },
    });
    const lines = outcomes.map((outcome) => `- #${outcome.number} ${outcome.shortId}: ${outcome.reason}`);
    const summary = [`## Sentry issues resolved in ${release}`, '', ...(lines.length === 0 ? ['No sentry-fix pull request shipped in this release.'] : lines), ''].join('\n');
    core.info(summary);
    await core.summary.addRaw(summary).write();
    core.setOutput('release', release);
}

const COMMANDS: Record<string, () => Promise<void>> = {
    plan: planCommand,
    fix: fixCommand,
    publish: publishCommand,
    merged: mergedCommand,
    release: releaseCommand,
};

const command = COMMANDS[core.getInput('command', { required: true })];
if (command === undefined) core.setFailed(`unknown command ${core.getInput('command')}; expected one of ${Object.keys(COMMANDS).join(', ')}`);
else {
    command().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
}
