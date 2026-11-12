export type ChangedFile = {
    path: string;
    previousPath?: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
};

export type PullRequest = {
    repo: string;
    number: number;
    title: string;
    body: string;
    author: string;
    baseRef: string;
    defaultBranch: string;
    headSha: string;
    draft: boolean;
    files: ChangedFile[];
};
