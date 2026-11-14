import { isNotFound, type Octokit, type RepoRef } from '../github/client.ts';
import { ensureLabels } from '../github/labels.ts';
import { projectOf, type SentryFixConfig } from './config.ts';
import { gate, type FixOutput } from './fix.ts';
import type { ChangedFile, FixResult, PlannedIssue } from './handoff.ts';
import { branchName, hasNote, LABELS, noteDate, type NoteMark } from './markers.ts';
import { noFixNote, prNote, renderPrBody } from './report.ts';
import { listNotes, postNote, type SentryOptions } from './sentry.ts';

export type PublishOptions = {
    octokit: Octokit;
    repo: RepoRef;
    sentry: SentryOptions;
    config: SentryFixConfig;
    now: Date;
};

export type Published =
    | { kind: 'pr'; url: string; created: boolean }
    | { kind: 'no-fix'; reasons: string[] }
    | { kind: 'not-published'; reason: string };

async function noteOnce(sentry: SentryOptions, issueId: string, mark: NoteMark, text: string): Promise<void> {
    if (hasNote(await listNotes(sentry, issueId), mark)) return;
    await postNote(sentry, issueId, text);
}

async function commitChanges(octokit: Octokit, repo: RepoRef, planned: PlannedIssue, output: FixOutput, changes: readonly ChangedFile[]) {
    const { data: base } = await octokit.rest.git.getCommit({ ...repo, commit_sha: planned.sha });
    const entries = [];
    for (const change of changes) {
        if (change.status === 'deleted') {
            entries.push({ path: change.path, mode: '100644' as const, type: 'blob' as const, sha: null });
            continue;
        }
        const { data: blob } = await octokit.rest.git.createBlob({ ...repo, content: change.content ?? '', encoding: 'base64' });
        entries.push({ path: change.path, mode: change.mode as '100644' | '100755', type: 'blob' as const, sha: blob.sha });
    }
    const { data: tree } = await octokit.rest.git.createTree({ ...repo, base_tree: base.tree.sha, tree: entries });
    return { tree: tree.sha, message: output.commitTitle };
}

// A rerun converges: the same tree on the same base keeps the branch as it is, and an open pull request is updated.
async function pointBranch(octokit: Octokit, repo: RepoRef, branch: string, planned: PlannedIssue, tree: string, message: string): Promise<void> {
    let current: string | undefined;
    try {
        current = (await octokit.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data.object.sha;
    } catch (error) {
        if (!isNotFound(error)) throw error;
    }
    if (current !== undefined) {
        const { data: head } = await octokit.rest.git.getCommit({ ...repo, commit_sha: current });
        if (head.tree.sha === tree && head.parents.length === 1 && head.parents[0]?.sha === planned.sha) return;
    }
    const { data: commit } = await octokit.rest.git.createCommit({ ...repo, message, tree, parents: [planned.sha] });
    if (current === undefined) await octokit.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: commit.sha });
    else await octokit.rest.git.updateRef({ ...repo, ref: `heads/${branch}`, sha: commit.sha, force: true });
}

async function openPullRequest(octokit: Octokit, repo: RepoRef, branch: string, title: string, body: string) {
    const { data: info } = await octokit.rest.repos.get({ ...repo });
    const { data: open } = await octokit.rest.pulls.list({ ...repo, state: 'open', head: `${repo.owner}:${branch}`, per_page: 1 });
    const existing = open[0];
    if (existing !== undefined) {
        await octokit.rest.pulls.update({ ...repo, pull_number: existing.number, title, body });
        return { number: existing.number, url: existing.html_url, created: false };
    }
    const { data: pr } = await octokit.rest.pulls.create({ ...repo, title, body, head: branch, base: info.default_branch, draft: false });
    return { number: pr.number, url: pr.html_url, created: true };
}

export async function publishPr(options: PublishOptions, planned: PlannedIssue, output: FixOutput, changes: readonly ChangedFile[]) {
    const { octokit, repo } = options;
    await ensureLabels(octokit, repo, [LABELS.autofix]);
    const branch = branchName(planned.context.issue.shortId);
    const { tree, message } = await commitChanges(octokit, repo, planned, output, changes);
    await pointBranch(octokit, repo, branch, planned, tree, message);
    const pr = await openPullRequest(octokit, repo, branch, output.commitTitle, renderPrBody(planned, output));
    await octokit.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels: [LABELS.autofix.name] });
    return pr;
}

export async function publish(planned: PlannedIssue, result: FixResult, options: PublishOptions): Promise<Published> {
    if (result.status === 'failed') return { kind: 'not-published', reason: `the fixer did not finish: ${result.error}` };
    const { output, changes } = result;
    const issue = planned.context.issue;
    const project = projectOf(options.config, issue.project);
    if (project === undefined) return { kind: 'not-published', reason: `${issue.project} is no longer in the config` };

    // The fix job ran code the fixer could change, so its verdict is checked again here against the config.
    const again = gate({ output, changes, project });
    const reasons = [...new Set([...(result.gate.open ? [] : result.gate.reasons), ...(again.open ? [] : again.reasons)])];
    if (reasons.length > 0) {
        const date = noteDate(options.now);
        await noteOnce(options.sentry, issue.id, { kind: 'no-fix', date }, noFixNote(date, output, reasons));
        return { kind: 'no-fix', reasons };
    }
    const pr = await publishPr(options, planned, output, changes);
    await noteOnce(options.sentry, issue.id, { kind: 'pr', url: pr.url }, prNote(pr.url, output));
    return { kind: 'pr', url: pr.url, created: pr.created };
}
