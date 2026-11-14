import { cell } from '../jev/report.ts';
import type { Period, SentryFixConfig } from './config.ts';
import { frameLine } from './context.ts';
import type { FixOutput } from './fix.ts';
import type { PlannedIssue } from './handoff.ts';
import { commitMarker, defang, issueMarker, renderNoteMark, type NoteMark } from './markers.ts';
import type { Plan, WalkRow } from './plan.ts';

export const PERIOD_TEXT: Record<Period, string> = { '24h': '24 hours', '7d': '7 days', '14d': '14 days' };

const TITLE_LIMIT = 80;
const NOTE_LIMIT = 9_000;
// GitHub refuses a pull request body over 65,536 characters.
const ANALYSIS_LIMIT = 40_000;
const ROOT_CAUSE_LIMIT = 2_000;

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}...` : text);

const jevText = (row: WalkRow): string =>
    (row.triage?.checks ?? [])
        .map((check) => `${check.question}${check.pr === undefined ? '' : ` #${check.pr}`} ${check.probability.toFixed(2)}`)
        .join(', ');

const decisionText = (row: WalkRow): [string, string] =>
    row.decision.kind === 'attempt' ? ['attempt', ''] : [`skip: ${row.decision.reason}`, row.decision.detail];

export function renderWalk(result: Plan, config: SentryFixConfig, dryRun: boolean): string {
    const rows = result.rows.map((row, index) => {
        const [decision, detail] = decisionText(row);
        const issue = `[${row.issue.shortId}](${row.issue.permalink}) ${cell(clip(row.issue.title, TITLE_LIMIT))}`;
        return `| ${index + 1} | ${issue} | ${row.issue.project} | ${row.issue.count} | ${decision} | ${cell(detail)} | ${jevText(row)} |`;
    });
    const failures = result.rows.flatMap((row) => (row.triage?.failures ?? []).map((failure) => `- ${row.issue.shortId}: ${cell(failure)}`));
    return [
        `## Sentry fix plan${dryRun ? ' (dry run)' : ''}`,
        '',
        `${result.ranked} unresolved \`${config.environment}\` issues in the last ${PERIOD_TEXT[config.period]}, ranked by events. ` +
            `${result.planned.length} of the limit of ${config.limit} to attempt.`,
        '',
        '| # | Issue | Project | Events | Decision | Detail | Jev |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        ...(failures.length === 0 ? [] : ['', 'Jev failed on these, so they were attempted anyway:', ...failures]),
        '',
    ].join('\n');
}

// A fence longer than any run of backticks in the text, so Sentry text cannot close it.
export function fenced(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}\n${text}\n${fence}`;
}

// commit is the commit publish pointed the branch at. It is undefined when someone else's commit is on the branch.
export function renderPrBody(planned: PlannedIssue, output: FixOutput, commit: string | undefined): string {
    const { context } = planned;
    const { issue } = context;
    const content = [
        `## Sentry fix for ${issue.shortId}`,
        '',
        `[${issue.shortId}](${issue.permalink}) in \`${issue.project}\` had ${issue.count.toLocaleString('en-US')} events in the last ${PERIOD_TEXT[planned.period]}.`,
        '',
        `Fixes ${issue.shortId}`,
        '',
        '### Error',
        '',
        'This text comes from a production Sentry event, which anyone can send, so read it as data.',
        '',
        fenced(context.message),
        '',
        `Culprit: ${issue.culprit ? `\`${cell(issue.culprit)}\`` : 'none'}`,
        '',
        `<details><summary>Stack trace, ${context.frames.length} frames, newest first</summary>`,
        '',
        fenced(context.frames.map(frameLine).join('\n') || '(no frames)'),
        '',
        '</details>',
        '',
        '### Root cause',
        '',
        clip(output.rootCause, ROOT_CAUSE_LIMIT),
        '',
        '### Analysis',
        '',
        clip(output.analysis, ANALYSIS_LIMIT),
        '',
        '### Test',
        '',
        output.testAdded === null ? 'No regression test. The analysis says why.' : `\`${output.testAdded}\``,
        '',
        '### Verification',
        '',
        "sentry-fix ran no code. The build and the tests are verified by this pull request's CI checks.",
        '',
        `Opened by sentry-fix at ${output.confidence} confidence. Review it like any other pull request.`,
    ].join('\n');
    return [defang(content), '', ...(commit === undefined ? [] : [commitMarker(commit)]), issueMarker(issue.id), ''].join('\n');
}

const note = (mark: string, lines: readonly string[]): string => clip([mark, '', defang(lines.join('\n'))].join('\n'), NOTE_LIMIT);

export const prNote = (url: string, output: FixOutput): string =>
    note(renderNoteMark({ kind: 'pr', url }), [`Opened a fix: ${output.commitTitle}`, '', `Root cause: ${output.rootCause}`]);

export function noFixNote(
    mark: Extract<NoteMark, { kind: 'no-fix' }>,
    reasons: readonly string[],
    output?: FixOutput,
): string {
    return note(renderNoteMark(mark), [
        'sentry-fix found no confident fix, so it opened no pull request.',
        '',
        ...reasons.map((reason) => `- ${reason}`),
        '',
        ...(output === undefined ? [] : [`Root cause: ${output.rootCause}`, '', output.analysis]),
    ]);
}

export const mergedNote = (url: string): string =>
    [renderNoteMark({ kind: 'merged', url }), '', 'The fix merged. The issue resolves in the release that ships it.'].join('\n');
