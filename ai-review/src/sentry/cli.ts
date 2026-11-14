import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getOctokit } from '@actions/github';
import { parseRepo } from '../github/client.ts';
import { DEFAULT_JEV_MODEL } from '../jev/transport.ts';
import { parseConfig } from './config.ts';
import { defaultBranchHead } from './github.ts';
import { plan } from './plan.ts';
import { renderWalk } from './report.ts';

const USAGE = `Usage: npm run sentry -- --dry-run --config <path> --repo <owner/repo> [--org <sentry org>] [--jev-model <id>]

Ranks the repository's production Sentry issues, applies the eligibility rules and Jev triage, and prints the
walk. It writes nothing: no agent runs, and nothing is posted to GitHub or Sentry.

  --config     a local sentry-fix config file
  --org        Sentry organization slug (default SENTRY_ORG)

Reads SENTRY_TOKEN, TYPESAFE_API_KEY and GH_TOKEN (or \`gh auth token\`).`;

const { values } = parseArgs({
    options: {
        'dry-run': { type: 'boolean', default: false },
        config: { type: 'string' },
        repo: { type: 'string' },
        org: { type: 'string', default: process.env['SENTRY_ORG'] ?? '' },
        'jev-model': { type: 'string', default: DEFAULT_JEV_MODEL },
        help: { type: 'boolean', default: false },
    },
});

function fail(message: string): never {
    console.error(`${message}\n\n${USAGE}`);
    process.exit(2);
}

if (values.help) {
    console.log(USAGE);
    process.exit(0);
}
if (!values['dry-run']) fail('Only --dry-run runs locally. The fixer runs in the sentry-fix workflow.');
if (values.config === undefined || values.repo === undefined) fail('Give --config and --repo.');
if (values.org === '') fail('Give --org or set SENTRY_ORG.');
const sentryToken = process.env['SENTRY_TOKEN'];
const apiKey = process.env['TYPESAFE_API_KEY'];
if (!sentryToken) fail('SENTRY_TOKEN is not set.');
if (!apiKey) fail('TYPESAFE_API_KEY is not set.');

const parsed = parseConfig(readFileSync(values.config, 'utf8'));
if (!parsed.ok) {
    console.error(`${values.config} is invalid: ${parsed.error}`);
    process.exit(1);
}

const repo = parseRepo(values.repo);
const octokit = getOctokit(process.env['GH_TOKEN'] || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim());
const head = await defaultBranchHead(octokit, repo);
const result = await plan({
    octokit,
    repo,
    sentry: { token: sentryToken, org: values.org },
    jev: { apiKey, model: values['jev-model'] },
    config: parsed.config,
    sha: head.sha,
    log: (message) => console.error(message),
});
console.log(renderWalk(result, parsed.config, true));
