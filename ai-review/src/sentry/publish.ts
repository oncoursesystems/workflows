import { isNotFound, type Octokit, type RepoRef } from '../github/client.ts';
import { ensureLabels } from '../github/labels.ts';
import { projectOf, type SentryFixConfig } from './config.ts';
import { gate, type FixOutput } from './fix.ts';
import type { ChangedFile, FixResult, PlannedIssue } from './handoff.ts';
import { branchName, hasNote, LABELS, markedCommit, noteDate, type NoteMark } from './markers.ts';
import { noFixNote, prNote, renderPrBody } from './report.ts';
import { listNotes, postNote, type SentryOptions } from './sentry.ts';

export type PublishOptions = {
    octokit: Octokit;
    repo: RepoRef;
    sentry: SentryOptions;
    config: SentryFixConfig;
    now: Date;
    run: string;
};

export type Published =
    | { kind: 'pr'; url: string; created: boolean; branch: BranchUpdate }
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

export type BranchUpdate = 'created' | 'moved' | 'unchanged' | 'kept';

type BranchHead = { sha: string; tree: string; parents: string[] };

async function branchHead(octokit: Octokit, repo: RepoRef, branch: string): Promise<BranchHead | undefined> {
    let sha: string;
    try {
        sha = (await octokit.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data.object.sha;
    } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
    }
    const { data } = await octokit.rest.git.getCommit({ ...repo, commit_sha: sha });
    return { sha, tree: data.tree.sha, parents: data.parents.map((parent) => parent.sha) };
}

// A rerun converges: the same tree on the same base keeps the branch as it is. The open pull request's body records
// the commit publish wrote, so a head that differs from it, or a body that records none, means someone else pushed,
// and the branch is theirs.
export function branchUpdate(head: BranchHead | undefined, recorded: string | undefined, base: string, tree: string, openPr: boolean): BranchUpdate {
    if (head === undefined) return 'created';
    if (openPr && head.sha !== recorded) return 'kept';
    return head.parents.length === 1 && head.parents[0] === base && head.tree === tree ? 'unchanged' : 'moved';
}

// The commit the branch points at once publish is done, or the one it recorded before when it kept the branch.
async function pointBranch(
    octokit: Octokit,
    repo: RepoRef,
    branch: string,
    update: BranchUpdate,
    head: BranchHead | undefined,
    recorded: string | undefined,
    commit: { base: string; tree: string; message: string },
): Promise<string | undefined> {
    if (update === 'kept') return recorded;
    if (update === 'unchanged') return head?.sha;
    const { data: created } = await octokit.rest.git.createCommit({ ...repo, message: commit.message, tree: commit.tree, parents: [commit.base] });
    if (update === 'created') await octokit.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: created.sha });
    else await octokit.rest.git.updateRef({ ...repo, ref: `heads/${branch}`, sha: created.sha, force: true });
    return created.sha;
}

async function findOpenPr(octokit: Octokit, repo: RepoRef, branch: string) {
    const { data: open } = await octokit.rest.pulls.list({ ...repo, state: 'open', head: `${repo.owner}:${branch}`, per_page: 1 });
    return open[0];
}

export async function publishPr(options: PublishOptions, planned: PlannedIssue, output: FixOutput, changes: readonly ChangedFile[]) {
    const { octokit, repo } = options;
    await ensureLabels(octokit, repo, [LABELS.autofix]);
    const branch = branchName(planned.context.issue.shortId);
    const { tree, message } = await commitChanges(octokit, repo, planned, output, changes);
    const open = await findOpenPr(octokit, repo, branch);
    const recorded = markedCommit(open?.body);
    const head = await branchHead(octokit, repo, branch);
    const update = branchUpdate(head, recorded, planned.sha, tree, open !== undefined);
    const commit = await pointBranch(octokit, repo, branch, update, head, recorded, { base: planned.sha, tree, message });
    const body = renderPrBody(planned, output, commit);
    let pr: { number: number; url: string; created: boolean };
    if (open !== undefined) {
        await octokit.rest.pulls.update({ ...repo, pull_number: open.number, ...(update === 'kept' ? {} : { title: output.commitTitle }), body });
        pr = { number: open.number, url: open.html_url, created: false };
    } else {
        const { data: info } = await octokit.rest.repos.get({ ...repo });
        const { data: created } = await octokit.rest.pulls.create({ ...repo, title: output.commitTitle, body, head: branch, base: info.default_branch, draft: false });
        pr = { number: created.number, url: created.html_url, created: true };
    }
    await octokit.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels: [LABELS.autofix.name] });
    return { ...pr, branch: update };
}
export async function publish(planned: PlannedIssue, result: FixResult, options: PublishOptions): Promise<Published> {
    if (result.status === 'failed') return { kind: 'not-published', reason: `the fixer did not finish: ${result.error}` };
    const issue = planned.context.issue;
    const mark = { kind: 'no-fix', date: noteDate(options.now), run: options.run } as const;
    if (result.status === 'exhausted') {
        await noteOnce(options.sentry, issue.id, mark, noFixNote(mark, [result.reason]));
        return { kind: 'no-fix', reasons: [result.reason] };
    }
    const { output, changes } = result;
    const project = projectOf(options.config, issue.project);
    if (project === undefined) return { kind: 'not-published', reason: `${issue.project} is no longer in the config` };

    // The result file comes from the fix job, which holds the Claude token, so its verdict is checked again here against the config.
    const again = gate({ output, changes, project });
    const reasons = [...new Set([...(result.gate.open ? [] : result.gate.reasons), ...(again.open ? [] : again.reasons)])];
    if (reasons.length > 0) {
        await noteOnce(options.sentry, issue.id, mark, noFixNote(mark, reasons, output));
        return { kind: 'no-fix', reasons };
    }
    const pr = await publishPr(options, planned, output, changes);
    await noteOnce(options.sentry, issue.id, { kind: 'pr', url: pr.url }, prNote(pr.url, output));
    return { kind: 'pr', url: pr.url, created: pr.created, branch: pr.branch };
}
