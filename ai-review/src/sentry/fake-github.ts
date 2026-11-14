import type { Octokit } from '../github/client.ts';

export type FakePr = {
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    merged: boolean;
    labels: string[];
    head: string;
    base: string;
    mergeCommitSha: string | null;
    files: string[];
};

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

let shaCounter = 0;
const nextSha = (): string => (++shaCounter).toString(16).padStart(40, '0');

// An in-memory repository with just the endpoints sentry-fix calls.
export class FakeGitHub {
    prs: FakePr[] = [];
    repoLabels: string[] = [];
    files = new Map<string, string>();
    refs = new Map<string, string>([['heads/main', 'a'.repeat(40)]]);
    blobs = new Map<string, string>();
    trees = new Map<string, { base: string | undefined; entries: Array<{ path: string; mode: string; sha: string | null }> }>();
    commits = new Map<string, { message: string; tree: string; parents: string[] }>([['a'.repeat(40), { message: 'base', tree: 't0', parents: [] }]]);
    compareCommits: string[] = [];
    calls: string[] = [];

    pr(fields: Partial<FakePr> & { number: number }): FakePr {
        const pr: FakePr = {
            title: `PR ${fields.number}`,
            body: '',
            state: 'open',
            merged: false,
            labels: [],
            head: `branch-${fields.number}`,
            base: 'main',
            mergeCommitSha: null,
            files: [],
            ...fields,
        };
        this.prs.push(pr);
        return pr;
    }

    private find(number: number): FakePr {
        const pr = this.prs.find((candidate) => candidate.number === number);
        if (pr === undefined) throw notFound();
        return pr;
    }

    private record(name: string) {
        this.calls.push(name);
    }

    private prData(pr: FakePr) {
        return {
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.state,
            merged: pr.merged,
            merge_commit_sha: pr.mergeCommitSha,
            html_url: `https://github.com/o/r/pull/${pr.number}`,
            labels: pr.labels.map((name) => ({ name })),
            head: { ref: pr.head },
        };
    }

    get octokit(): Octokit {
        const rest = {
            repos: {
                get: async () => ({ data: { default_branch: 'main' } }),
                getBranch: async ({ branch }: { branch: string }) => {
                    const sha = this.refs.get(`heads/${branch}`);
                    if (sha === undefined) throw notFound();
                    return { data: { commit: { sha } } };
                },
                getContent: async ({ path }: { path: string }) => {
                    const text = this.files.get(path);
                    if (text === undefined) throw notFound();
                    return { data: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } };
                },
                compareCommitsWithBasehead: async ({ per_page, page }: { per_page: number; page: number }) => ({
                    data: { commits: this.compareCommits.slice((page - 1) * per_page, page * per_page).map((sha) => ({ sha })) },
                }),
            },
            issues: {
                listForRepo: async ({ labels, state }: { labels: string; state: string }) => ({
                    data: this.prs
                        .filter((pr) => pr.labels.some((label) => label.toLowerCase() === labels.toLowerCase()))
                        .filter((pr) => state === 'all' || pr.state === state)
                        .map((pr) => ({ ...this.prData(pr), pull_request: { merged_at: pr.merged ? '2026-11-10T00:00:00Z' : null } })),
                }),
                listLabelsForRepo: async () => ({ data: this.repoLabels.map((name) => ({ name })) }),
                createLabel: async ({ name }: { name: string }) => {
                    this.record(`createLabel ${name}`);
                    this.repoLabels.push(name);
                },
                listLabelsOnIssue: async ({ issue_number }: { issue_number: number }) => ({
                    data: this.find(issue_number).labels.map((name) => ({ name })),
                }),
                addLabels: async ({ issue_number, labels }: { issue_number: number; labels: string[] }) => {
                    this.record(`addLabels #${issue_number} ${labels.join(',')}`);
                    const pr = this.find(issue_number);
                    pr.labels = [...new Set([...pr.labels, ...labels])];
                },
                removeLabel: async ({ issue_number, name }: { issue_number: number; name: string }) => {
                    this.record(`removeLabel #${issue_number} ${name}`);
                    const pr = this.find(issue_number);
                    if (!pr.labels.includes(name)) throw notFound();
                    pr.labels = pr.labels.filter((label) => label !== name);
                },
            },
            pulls: {
                list: async ({ state, head }: { state: string; head?: string }) => ({
                    data: this.prs
                        .filter((pr) => pr.state === state && (head === undefined || head === `o:${pr.head}`))
                        .map((pr) => this.prData(pr)),
                }),
                listFiles: async ({ pull_number }: { pull_number: number }) => ({
                    data: this.find(pull_number).files.map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 0, patch: '@@ +x' })),
                }),
                get: async ({ pull_number }: { pull_number: number }) => ({ data: this.prData(this.find(pull_number)) }),
                create: async ({ title, body, head, base, draft }: { title: string; body: string; head: string; base: string; draft: boolean }) => {
                    this.record(`create ${head} -> ${base}${draft ? ' draft' : ''}`);
                    const number = Math.max(100, ...this.prs.map((pr) => pr.number)) + 1;
                    return { data: this.prData(this.pr({ number, title, body, head, base })) };
                },
                update: async ({ pull_number, title, body }: { pull_number: number; title: string; body: string }) => {
                    this.record(`update #${pull_number}`);
                    const pr = this.find(pull_number);
                    Object.assign(pr, { title, body });
                    return { data: this.prData(pr) };
                },
            },
            git: {
                getCommit: async ({ commit_sha }: { commit_sha: string }) => {
                    const commit = this.commits.get(commit_sha);
                    if (commit === undefined) throw notFound();
                    return { data: { sha: commit_sha, tree: { sha: commit.tree } } };
                },
                createBlob: async ({ content }: { content: string }) => {
                    const sha = nextSha();
                    this.blobs.set(sha, Buffer.from(content, 'base64').toString('utf8'));
                    return { data: { sha } };
                },
                createTree: async ({ base_tree, tree }: { base_tree?: string; tree: Array<{ path: string; mode: string; sha: string | null }> }) => {
                    const sha = nextSha();
                    this.trees.set(sha, { base: base_tree, entries: tree });
                    return { data: { sha } };
                },
                createCommit: async ({ message, tree, parents }: { message: string; tree: string; parents: string[] }) => {
                    const sha = nextSha();
                    this.commits.set(sha, { message, tree, parents });
                    return { data: { sha } };
                },
                getRef: async ({ ref }: { ref: string }) => {
                    const sha = this.refs.get(ref);
                    if (sha === undefined) throw notFound();
                    return { data: { object: { sha } } };
                },
                createRef: async ({ ref, sha }: { ref: string; sha: string }) => {
                    this.record(`createRef ${ref}`);
                    this.refs.set(ref.replace(/^refs\//, ''), sha);
                },
                updateRef: async ({ ref, sha, force }: { ref: string; sha: string; force: boolean }) => {
                    this.record(`updateRef ${ref}${force ? ' force' : ''}`);
                    this.refs.set(ref, sha);
                },
            },
        };
        const paginate = async (method: (params: never) => Promise<{ data: unknown }>, params: never) => (await method(params)).data;
        return { rest, paginate } as unknown as Octokit;
    }
}
