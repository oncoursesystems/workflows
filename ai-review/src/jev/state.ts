import type { ChangedFile, PullRequest } from '../github/pull-request.ts';

const JEV_QUESTION_CONTEXT_TOKENS = 32_000;
const MEASURED_CHARS_PER_TOKEN = 3.4;
const JEV_OVERHEAD_TOKENS = 300;
const DENSE_CODE_MARGIN_TOKENS = 7_700;

export type Questions = Record<string, unknown>;

export function stateBudgetChars(questions: Questions): number {
    const largestQuestion = Math.max(0, ...Object.values(questions).map((question) => JSON.stringify(question).length));
    const context = (JEV_QUESTION_CONTEXT_TOKENS - JEV_OVERHEAD_TOKENS - DENSE_CODE_MARGIN_TOKENS) * MEASURED_CHARS_PER_TOKEN;
    return Math.max(0, Math.floor(context - largestQuestion));
}

export type DiffCoverage = 'complete' | 'truncated' | 'omitted';

export type DiffText = { text: string; coverage: DiffCoverage };

const fileDiff = (file: ChangedFile): string => {
    const header = `diff --git a/${file.previousPath ?? file.path} b/${file.path} (${file.status})`;
    return `${header}\n${file.patch ?? '(no patch: binary or too large to show)'}\n`;
};

export function diffOfWholeFilesThatFit(files: readonly ChangedFile[], budget: number): DiffText {
    let text = '';
    let shown = 0;
    for (const file of files) {
        const chunk = fileDiff(file);
        if (text.length + chunk.length > budget) continue;
        text += chunk;
        shown++;
    }
    if (shown === files.length) return { text, coverage: 'complete' };
    return { text: `${text}[diff truncated: ${shown} of ${files.length} files shown]`, coverage: 'truncated' };
}

export const omittedDiff = (files: readonly ChangedFile[]): DiffText => ({
    text: `[diff omitted: the patches of ${files.length} files are too large for the model context]`,
    coverage: 'omitted',
});

const fileEntry = (file: ChangedFile) => ({
    path: file.path,
    ...(file.previousPath === undefined ? {} : { previous_path: file.previousPath }),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
});

export type FileList = { entries: ReturnType<typeof fileEntry>[]; total: number };

export function fileListThatFits(files: readonly ChangedFile[], budget: number): FileList {
    const entries: ReturnType<typeof fileEntry>[] = [];
    let used = 0;
    for (const file of files) {
        const entry = fileEntry(file);
        const size = JSON.stringify(entry).length + 1;
        if (used + size > budget) break;
        entries.push(entry);
        used += size;
    }
    return { entries, total: files.length };
}

export function buildState(pr: PullRequest, fileList: FileList, diff: DiffText) {
    const { entries, total } = fileList;
    return {
        pull_request: { title: pr.title, body: pr.body, author: pr.author },
        files: entries,
        ...(entries.length === total ? {} : { files_truncated: `${entries.length} of ${total} files listed` }),
        diff: diff.text,
    };
}
