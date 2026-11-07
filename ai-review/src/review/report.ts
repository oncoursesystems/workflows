import type { ReviewedFinding } from './finding.ts';
import { findersFor, VERIFIER_MODEL } from './plan.ts';
import type { ReviewResult } from './review.ts';
import { fingerprint, fingerprintMarker, MAX_ROUNDS, renderState, SUMMARY_MARKER, type ReviewState } from './state.ts';

const confirmations = (finding: ReviewedFinding): string =>
    `${finding.verdicts.filter((verdict) => verdict.real).length} of ${finding.verdicts.length} reviewers confirmed`;

const shortSha = (sha: string): string => sha.slice(0, 7);

const minutes = (ms: number): string => `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

export function inlineBody(finding: ReviewedFinding): string {
    return [
        `**Important (${finding.kind}):** ${finding.claim}`,
        '',
        `**Failure scenario:** ${finding.failureScenario}`,
        '',
        `<sub>${confirmations(finding)}. AI review trial run, blocks nothing.</sub>`,
        fingerprintMarker(fingerprint(finding)),
    ].join('\n');
}

const listItem = (finding: ReviewedFinding): string =>
    `- \`${finding.file}:${finding.line}\` ${finding.claim} **Failure scenario:** ${finding.failureScenario} <sub>(${confirmations(finding)})</sub>`;

const section = (title: string, findings: readonly ReviewedFinding[]): string[] =>
    findings.length === 0 ? [] : ['', `### ${title}`, ...findings.map(listItem)];

export type SummaryInput = {
    result: ReviewResult;
    state: ReviewState;
    inline: readonly ReviewedFinding[];
    outsideDiff: readonly ReviewedFinding[];
    scope: string;
};

export function renderSummary({ result, state, inline, outsideDiff, scope }: SummaryInput): string {
    const finders = findersFor(result.tier);
    const finderModel = finders[0]?.model ?? '';
    const of = (placement: ReviewedFinding['placement']) => result.findings.filter((finding) => finding.placement === placement);
    const dropped = of('dropped').length;
    const headline =
        inline.length + outsideDiff.length === 0
            ? 'No important findings.'
            : `**${inline.length + outsideDiff.length} important** finding${inline.length + outsideDiff.length === 1 ? '' : 's'}` +
              (inline.length > 0 ? `, ${inline.length} posted as review comments.` : '.');
    return [
        SUMMARY_MARKER,
        '## AI review (trial run)',
        `Round ${state.round} of ${MAX_ROUNDS} on \`${shortSha(state.reviewedSha)}\`, reviewing ${scope}. ` +
            `${result.tier[0]?.toUpperCase()}${result.tier.slice(1)} risk: ${finders.length} \`${finderModel}\` bug ` +
            `finder${finders.length === 1 ? '' : 's'}, 3 \`${VERIFIER_MODEL}\` reviewers per finding.`,
        '',
        headline,
        ...section('Important, outside the diff', outsideDiff),
        ...section('Nits', of('nit')),
        ...section('Pre-existing', of('pre-existing')),
        '',
        `<sub>${result.candidates} candidate${result.candidates === 1 ? '' : 's'} checked, ${dropped} dropped by the ` +
            `reviewers. $${result.costUsd.toFixed(2)}, ${minutes(result.durationMs)}. This trial run blocks nothing.</sub>`,
        renderState(state),
    ].join('\n');
}

export function renderRoundLimit(state: ReviewState): string {
    return [
        SUMMARY_MARKER,
        '## AI review (trial run)',
        `This pull request has had ${MAX_ROUNDS} review rounds, so the review stopped. ` +
            'If important findings are still open, rethink the approach, or remove and re-add the `ai-review` label to start over.',
        renderState(state),
    ].join('\n');
}

export function checkTitle(inlineCount: number, otherImportant: number, nits: number): string {
    const important = inlineCount + otherImportant;
    return `${important} important, ${nits} nit${nits === 1 ? '' : 's'} (trial run)`;
}
