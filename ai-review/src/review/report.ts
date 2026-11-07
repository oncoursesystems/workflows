import { createHash } from 'node:crypto';
import type { ReviewedFinding } from './finding.ts';
import { findersFor, VERIFIER_MODEL } from './plan.ts';
import type { AgentReport, ReviewResult } from './review.ts';
import { fingerprint, fingerprintMarker, MAX_ROUNDS, renderState, SUMMARY_MARKER, type ReviewState } from './state.ts';

const HEADING = '## AI review';

export const MINOR_HEADINGS = [
    'Minor Details',
    'Minutiae',
    'Quibbles',
    'Trifles',
    'Trivialities',
    'Polishing Points',
    'Petty Criticisms',
    'Splitting Hairs',
    'Carping',
    'Sweating the Small Stuff',
    'Loose Threads',
    'Fine Print',
    'Odds and Ends',
    'Small Potatoes',
] as const;

export function minorHeading(sha: string): string {
    const index = createHash('sha256').update(sha).digest().readUInt32BE(0) % MINOR_HEADINGS.length;
    return MINOR_HEADINGS[index] ?? MINOR_HEADINGS[0];
}

const confirmations = (finding: ReviewedFinding): string =>
    `${finding.verdicts.filter((verdict) => verdict.real).length} of ${finding.verdicts.length} reviewers confirmed`;

const shortSha = (sha: string): string => sha.slice(0, 7);

const seconds = (ms: number): number => Math.round(ms / 1000);

const minutes = (ms: number): string => `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

const roundLine = (state: ReviewState, scope: string, verb: string): string =>
    `${verb} \`${shortSha(state.reviewedSha)}\`, ${scope} (round ${state.round} of ${MAX_ROUNDS}).`;

export function inlineBody(finding: ReviewedFinding): string {
    return [
        `**Important (${finding.kind})**`,
        '',
        finding.claim,
        '',
        `**Failure scenario:** ${finding.failureScenario}`,
        '',
        `<sub>${confirmations(finding)}. React 👍 if this is a real problem or 👎 if it is wrong.</sub>`,
        fingerprintMarker(fingerprint(finding)),
    ].join('\n');
}

const findingBlock = (repo: string, sha: string, finding: ReviewedFinding): string[] => [
    '',
    `**[\`${finding.file}:${finding.line}\`](https://github.com/${repo}/blob/${sha}/${finding.file}#L${finding.line})** (${finding.kind})`,
    '',
    finding.claim,
    '',
    `**Failure scenario:** ${finding.failureScenario}`,
    '',
    `<sub>${confirmations(finding)}.</sub>`,
];

const section = (title: string, repo: string, sha: string, findings: readonly ReviewedFinding[]): string[] =>
    findings.length === 0 ? [] : ['', `### ${title}`, ...findings.flatMap((finding) => findingBlock(repo, sha, finding))];

export type SummaryInput = {
    repo: string;
    result: ReviewResult;
    state: ReviewState;
    inline: readonly ReviewedFinding[];
    outsideDiff: readonly ReviewedFinding[];
    scope: string;
    notes?: readonly string[];
};

export function renderSummary({ repo, result, state, inline, outsideDiff, scope, notes = [] }: SummaryInput): string {
    const finders = findersFor(result.tier);
    const of = (placement: ReviewedFinding['placement']) => result.findings.filter((finding) => finding.placement === placement);
    const important = inline.length + outsideDiff.length;
    const headline =
        important === 0
            ? '**No important findings.**'
            : `**${plural(important, 'important finding')}**` +
              (inline.length === 0 ? '.' : `, ${inline.length === important ? '' : `${inline.length} `}posted as review comments.`);
    const sha = state.reviewedSha;
    return [
        SUMMARY_MARKER,
        HEADING,
        '',
        roundLine(state, scope, 'Reviewed'),
        `${result.tier[0]?.toUpperCase()}${result.tier.slice(1)} risk: ${plural(finders.length, 'bug finder')} on ` +
            `\`${finders[0]?.model ?? ''}\`, and 3 reviewers on \`${VERIFIER_MODEL}\` for each finding.`,
        ...notes,
        '',
        headline,
        ...section('Important, outside the diff', repo, sha, outsideDiff),
        ...section(minorHeading(sha), repo, sha, of('minor')),
        ...section('Pre-existing', repo, sha, of('pre-existing')),
        '',
        `<sub>${plural(result.candidates, 'candidate')} checked, ${of('dropped').length} dropped by the reviewers. ` +
            `$${result.costUsd.toFixed(2)}, ${minutes(result.durationMs)}.</sub>`,
        renderState(state),
    ].join('\n');
}

export function renderRunning(state: ReviewState, scope: string, previous: ReviewState | undefined): string {
    return [
        SUMMARY_MARKER,
        HEADING,
        '',
        roundLine(state, scope, 'Reviewing'),
        'This comment updates when the review finishes.',
        ...(previous === undefined ? [] : [renderState(previous)]),
    ].join('\n');
}

export function renderFailed(state: ReviewState, message: string, previous: ReviewState | undefined): string {
    return [
        SUMMARY_MARKER,
        HEADING,
        '',
        `The review of \`${shortSha(state.reviewedSha)}\` did not finish: ${message}`,
        "Push again to retry, or run the `ai-review` workflow by hand with this pull request's number to start over.",
        ...(previous === undefined ? [] : [renderState(previous)]),
    ].join('\n');
}

export function renderRoundLimit(state: ReviewState): string {
    return [
        SUMMARY_MARKER,
        HEADING,
        '',
        `This pull request has had ${MAX_ROUNDS} review rounds, so the review stopped.`,
        "If important findings are still open, rethink the approach, or run the `ai-review` workflow by hand with this pull request's number to start over.",
        renderState(state),
    ].join('\n');
}

export function checkTitle(important: number, minor: number): string {
    return `${important} important, ${minor} minor`;
}

export function renderAgentLog(agents: readonly AgentReport[]): string {
    const rows = agents.map((agent) => {
        const tools = Object.entries(agent.tools)
            .map(([name, count]) => `${name} ${count}`)
            .join(', ');
        const denied = agent.denied.length === 0 ? '' : ` | denied: ${agent.denied.join(', ')}`;
        return `${agent.role} | ${agent.model} | ${plural(agent.turns, 'turn')} | ${tools || 'no tool calls'} | ` +
            `$${agent.costUsd.toFixed(2)} | ${seconds(agent.durationMs)}s${denied}`;
    });
    return ['role | model | turns | tool calls | cost | time', ...rows].join('\n');
}
