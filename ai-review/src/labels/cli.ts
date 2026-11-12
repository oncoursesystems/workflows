import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getOctokit } from '@actions/github';
import { fetchPullRequest, parsePullRequestRef } from '../github/client.ts';
import { DEFAULT_JEV_MODEL } from '../jev/transport.ts';
import { DEFAULT_CONFIG_PATH, lookupConfig } from './config.ts';
import { renderSummary } from './report.ts';
import { fetchConfig, labelPullRequest } from './run.ts';

const USAGE = `Usage: npm run labels -- <owner/repo#number | pull request URL> [options]

Asks Jev about each label in the config and adds or removes the labels on the pull request.

  --dry-run              print the answers and the planned changes, and write nothing
  --config-file <path>   use a local config file instead of the one on the default branch
  --config-path <path>   config path on the default branch (default ${DEFAULT_CONFIG_PATH})
  --jev-model <id>       Jev model (default ${DEFAULT_JEV_MODEL})

Reads GH_TOKEN (or \`gh auth token\`) and TYPESAFE_API_KEY.`;

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        'dry-run': { type: 'boolean', default: false },
        'config-file': { type: 'string' },
        'config-path': { type: 'string', default: DEFAULT_CONFIG_PATH },
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
const [target, ...extra] = positionals;
if (target === undefined || extra.length > 0) fail('Give exactly one pull request as owner/repo#number or a URL.');
const { repo, number } = parsePullRequestRef(target);

const githubToken = process.env['GH_TOKEN'] || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const apiKey = process.env['TYPESAFE_API_KEY'];
if (!apiKey) fail('TYPESAFE_API_KEY is not set.');

const octokit = getOctokit(githubToken);
const pr = await fetchPullRequest(octokit, repo, number);
const lookup =
    values['config-file'] === undefined
        ? await fetchConfig(octokit, repo, pr.defaultBranch, values['config-path'])
        : lookupConfig(readFileSync(values['config-file'], 'utf8'), values['config-file']);
if (lookup.kind === 'missing') {
    console.log(`No config on ${lookup.ref}, so there is nothing to ask.`);
    process.exit(0);
}
if (lookup.kind === 'invalid') {
    console.error(`The config on ${lookup.ref} is invalid: ${lookup.error}`);
    process.exit(1);
}

const result = await labelPullRequest(octokit, repo, pr, lookup.rules, { apiKey, model: values['jev-model'] }, values['dry-run']);
if (result.status === 'failed') {
    console.error(`Jev failed: ${result.error}`);
    process.exit(1);
}
console.log(renderSummary(result));
console.log(`${values['dry-run'] ? 'Planned' : 'Applied'}: add [${result.change.add.join(', ')}], remove [${result.change.remove.join(', ')}].`);
console.log(`Managed labels after: [${result.labelsAfter.join(', ')}].`);
