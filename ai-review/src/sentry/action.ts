import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { DEFAULT_JEV_MODEL } from '../jev/transport.ts';
import { DEFAULT_CONFIG_PATH } from './config.ts';
import { runSessionContainer, runVerification, type DockerContext } from './docker.ts';
import { CLAUDE_AUTH_VARIABLE } from './env.ts';
import { runFixer } from './fixer.ts';
import { defaultBranchHead, requireConfig } from './github.ts';
import { encodePlan, FixResult, PLAN_FILE, plannedIssue, readJson, readPlan, type PlannedIssue } from './handoff.ts';
import { buildImage, imageArgs } from './image.ts';
import { onMerged } from './merged.ts';
import { plan } from './plan.ts';
import { publish } from './publish.ts';
import { allFailed, resolveRelease, type ResolveOutcome } from './release.ts';
import { renderWalk } from './report.ts';
import type { SentryOptions } from './sentry.ts';

// One entry point, so the composite actions share one install. Each step passes only the secrets its command needs.

const RESULT_FILE = 'result.json';

// The ai-review directory, which the fixer's container mounts read-only to run its entry point.
const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The workflow uploads each fix job's result as this artifact, and download-artifact puts it in a directory of the same name.
const artifactName = (issueId: string): string => `sentry-fix-result-${issueId}`;

const readPlanInput = () => readPlan(core.getInput('plan-file', { required: true }), core.getInput('plan-sha256', { required: true }));

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
    const encoded = encodePlan(dryRun ? [] : result.planned);
    const dir = core.getInput('plan-dir', { required: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PLAN_FILE), encoded.bytes);
    core.setOutput('plan-sha256', encoded.sha256);
    core.setOutput('issues', JSON.stringify(encoded.keys));
    core.setOutput('count', String(encoded.keys.length));
    core.setOutput('sha', head.sha);
}

async function fixerImage(cwd: string): Promise<string> {
    const image = core.getInput('fix-image');
    if (image !== '') return image;
    const globalJsonFile = core.getInput('global-json-file');
    const args = imageArgs({
        dotnetVersion: core.getInput('dotnet-version'),
        nodeVersion: core.getInput('node-version'),
        globalJson: globalJsonFile === '' ? undefined : await readFile(resolve(cwd, globalJsonFile), 'utf8'),
    });
    core.info(`Building the fixer image with .NET SDK ${args.dotnetSdkVersion} and Node.js ${args.nodeVersion}.`);
    return buildImage(core.getInput('dockerfile', { required: true }), args, process.env);
}

async function fixIn(cwd: string, planned: PlannedIssue): Promise<FixResult> {
    const token = process.env[CLAUDE_AUTH_VARIABLE] ?? '';
    if (token === '') return { status: 'failed', error: `${CLAUDE_AUTH_VARIABLE} is not set` };
    core.setSecret(token);
    let image: string;
    try {
        image = await fixerImage(cwd);
    } catch (error) {
        return { status: 'failed', error: `the fixer image did not build: ${error instanceof Error ? error.message : String(error)}` };
    }
    const session = await mkdtemp(join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'sentry-fix-session-'));
    const docker: DockerContext = {
        image,
        name: `sentry-fix-${planned.context.issue.id}-${context.runId}-${context.runAttempt}`,
        user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        mounts: { work: cwd, harness: HARNESS_DIR, node: dirname(dirname(process.execPath)), session },
        source: process.env,
        extraEnv: planned.project.env,
    };
    try {
        return await runFixer({
            planned,
            cwd,
            containers: { session: (request) => runSessionContainer(docker, request), verify: (commands) => runVerification(docker, commands) },
            secrets: () => [token],
        });
    } finally {
        await rm(session, { recursive: true, force: true });
    }
}

async function fixCommand(): Promise<void> {
    const planned = plannedIssue(await readPlanInput(), core.getInput('issue-id', { required: true }));
    const out = core.getInput('out-dir', { required: true });
    const result = await fixIn(process.env['GITHUB_WORKSPACE'] ?? process.cwd(), planned);
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
    for (const run of result.verification) core.info(`Verified \`${run.command}\`: exit code ${run.exitCode ?? 'none, it did not finish'}.`);
}

async function publishCommand(): Promise<void> {
    const octokit = getOctokit(core.getInput('bot-token', { required: true }));
    const sentry = sentryOptions();
    const head = await defaultBranchHead(octokit, context.repo);
    const config = await requireConfig(octokit, context.repo, head.branch, configPath());
    const dir = core.getInput('results-dir', { required: true });
    const issues = await readPlanInput();
    const lines: string[] = [];
    let failures = 0;
    for (const planned of issues) {
        const { id, shortId } = planned.context.issue;
        const path = join(dir, artifactName(id), RESULT_FILE);
        try {
            if (!(await access(path).then(() => true, () => false))) {
                lines.push(`- ${shortId}: not published, because the fix job left no result`);
                continue;
            }
            const published = await publish(planned, await readJson(path, FixResult), {
                octokit,
                repo: context.repo,
                sentry,
                config,
                now: new Date(),
                run: String(context.runId),
            });
            if (published.kind === 'pr' && published.branch === 'kept') {
                lines.push(`- ${shortId}: updated the body of ${published.url}, and left its branch alone, because someone else pushed to it`);
            } else if (published.kind === 'pr') lines.push(`- ${shortId}: ${published.created ? 'opened' : 'updated'} ${published.url}`);
            else if (published.kind === 'no-fix') lines.push(`- ${shortId}: no confident fix, noted on Sentry. ${published.reasons.join(' ')}`);
            else lines.push(`- ${shortId}: not published, because ${published.reason}`);
        } catch (error) {
            failures++;
            core.error(`${shortId}: ${error instanceof Error ? error.message : String(error)}`);
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
            headRef: (pr['head'] as { ref: string }).ref,
        },
        octokit,
        context.repo,
        sentryOptions(),
    );
    if (outcome.kind === 'marked') core.info(`#${pr.number} marked as merged for Sentry issue ${outcome.issueId}.`);
    else if (outcome.kind === 'mismatch') core.warning(`#${pr.number} skipped: ${outcome.reason}.`);
    else core.info(`#${pr.number} ignored: ${outcome.reason}.`);
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
    const label = (outcome: ResolveOutcome) => `#${outcome.number} ${outcome.shortId ?? `issue ${outcome.issueId}`}: ${outcome.reason}`;
    for (const outcome of outcomes) if (outcome.status === 'failed' || outcome.status === 'mismatch') core.warning(label(outcome));
    const lines = outcomes.map((outcome) => `- ${label(outcome)}`);
    const summary = [`## Sentry issues resolved in ${release}`, '', ...(lines.length === 0 ? ['No sentry-fix pull request shipped in this release.'] : lines), ''].join('\n');
    core.info(summary);
    await core.summary.addRaw(summary).write();
    core.setOutput('release', release);
    if (allFailed(outcomes)) core.setFailed(`Every sentry-fix pull request in ${release} failed to resolve.`);
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
