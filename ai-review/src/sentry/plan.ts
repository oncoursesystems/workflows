import type { Octokit, RepoRef } from '../github/client.ts';
import type { JevOptions } from '../jev/transport.ts';
import { projectOf, type SentryFixConfig } from './config.ts';
import { issueContext } from './context.ts';
import { decide, type AutoFixPr, type Decision } from './eligibility.ts';
import { listAutoFixPrs, listOpenPrs, openPrsWithFiles, type OpenPrSummary } from './github.ts';
import type { PlannedIssue } from './handoff.ts';
import { issueMarker, mentionsShortId, parseNoteMark, type NoteMark } from './markers.ts';
import { latestEvent, listNotes, projectId, rankIssues, type SentryIssue, type SentryOptions } from './sentry.ts';
import { triage, type Triage } from './triage.ts';

export type WalkRow = { issue: SentryIssue; decision: Decision; triage?: Triage };

export type Judgement<T> = { decision: Decision; triage?: Triage; planned?: T };

// Walk the ranking from the top and stop once `limit` issues are attempted, so skipped issues are backfilled.
export async function walk<T>(
    issues: readonly SentryIssue[],
    limit: number,
    judge: (issue: SentryIssue) => Promise<Judgement<T>>,
): Promise<{ rows: WalkRow[]; planned: T[] }> {
    const rows: WalkRow[] = [];
    const planned: T[] = [];
    for (const issue of issues) {
        if (planned.length >= limit) break;
        const judgement = await judge(issue);
        rows.push({ issue, decision: judgement.decision, ...(judgement.triage === undefined ? {} : { triage: judgement.triage }) });
        if (judgement.decision.kind === 'attempt' && judgement.planned !== undefined) planned.push(judgement.planned);
    }
    return { rows, planned };
}

export const mentioningOpenPrs = (issue: SentryIssue, prs: readonly OpenPrSummary[]): number[] =>
    prs
        .filter((pr) => pr.body.includes(issueMarker(issue.id)) || mentionsShortId(`${pr.title}\n${pr.body}`, issue.shortId))
        .map((pr) => pr.number);

export const sentryFixNotes = (notes: readonly string[]): NoteMark[] => notes.flatMap((note) => parseNoteMark(note) ?? []);

export type PlanOptions = {
    octokit: Octokit;
    repo: RepoRef;
    sentry: SentryOptions;
    jev: JevOptions;
    config: SentryFixConfig;
    sha: string;
    log: (message: string) => void;
};

export type Plan = { ranked: number; rows: WalkRow[]; planned: PlannedIssue[] };

export async function plan(options: PlanOptions): Promise<Plan> {
    const { octokit, repo, sentry, jev, config, log } = options;
    const projectIds: string[] = [];
    for (const project of config.projects) projectIds.push(await projectId(sentry, project.slug));
    const ranked = (await rankIssues(sentry, { projectIds, environment: config.environment, period: config.period })).filter(
        (issue) => projectOf(config, issue.project) !== undefined,
    );
    const autoPrs: AutoFixPr[] = await listAutoFixPrs(octokit, repo);
    const openPrs = await listOpenPrs(octokit, repo);
    const openPrFiles = openPrsWithFiles(octokit, repo, openPrs);

    const { rows, planned } = await walk<PlannedIssue>(ranked, config.limit, async (issue) => {
        const project = projectOf(config, issue.project)!;
        const decision = decide(issue, {
            autoPrs: autoPrs.filter((pr) => pr.sentryIssueId === issue.id),
            mentioningOpenPrs: mentioningOpenPrs(issue, openPrs),
            notes: sentryFixNotes(await listNotes(sentry, issue.id)),
        });
        if (decision.kind === 'skip') return { decision };
        const context = issueContext(issue, await latestEvent(sentry, issue.id));
        const triaged = await triage(context, project, openPrFiles, jev);
        for (const failure of triaged.failures) log(`${issue.shortId}: Jev failed, so the issue is attempted: ${failure}`);
        return {
            decision: triaged.decision,
            triage: triaged,
            planned: { sha: options.sha, period: config.period, project, context },
        };
    });
    return { ranked: ranked.length, rows, planned };
}
