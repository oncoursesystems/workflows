import type { ChangedFile, PullRequest } from '../github/pull-request.ts';
import {
    buildState,
    diffOfWholeFilesThatFit,
    fileListThatFits,
    omittedDiff,
    stateBudgetChars,
    type DiffCoverage,
    type DiffText,
    type Questions,
} from './state.ts';
import { post, type JevOptions } from './transport.ts';

const CONTEXT_RETRIES = 6;
const MIN_DIFF_CHARS = 1_000;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type JevAsk<T> = {
    pr: PullRequest;
    files: readonly ChangedFile[];
    questions: Questions;
    parse: (body: unknown) => ParseResult<T>;
};

export type JevAnswer<T> = { status: 'answered'; value: T; diff: DiffCoverage } | { status: 'failed'; error: string };

export async function askJev<T>(ask: JevAsk<T>, options: JevOptions): Promise<JevAnswer<T>> {
    const { pr, files, questions } = ask;
    const budget = stateBudgetChars(questions);
    const empty: DiffText = { text: '', coverage: 'complete' };
    const metadata = JSON.stringify(buildState(pr, { entries: [], total: 0 }, empty)).length;
    let fileBudget = budget - metadata;
    let fileList = fileListThatFits(files, fileBudget);
    const request = (diff: DiffText) =>
        JSON.stringify({ model: options.model, state: buildState(pr, fileList, diff), questions });

    const withoutDiff = JSON.stringify(buildState(pr, fileList, empty)).length;
    let diff = diffOfWholeFilesThatFit(files, budget - withoutDiff);
    let attempt = await post(request(diff), options);
    for (let retry = 0; attempt.kind === 'too-long' && retry < CONTEXT_RETRIES; retry++) {
        if (diff.coverage === 'omitted') {
            fileBudget = Math.floor(fileBudget / 2);
            fileList = fileListThatFits(files, fileBudget);
        } else {
            const smallerDiff = Math.floor(diff.text.length / 4);
            diff = smallerDiff >= MIN_DIFF_CHARS ? diffOfWholeFilesThatFit(files, smallerDiff) : omittedDiff(files);
        }
        attempt = await post(request(diff), options);
    }
    switch (attempt.kind) {
        case 'too-long':
            return { status: 'failed', error: 'the request exceeds the model context even without the diff and with a shortened file list' };
        case 'error':
            return { status: 'failed', error: attempt.error };
        case 'ok': {
            const parsed = ask.parse(attempt.body);
            if (!parsed.ok) return { status: 'failed', error: parsed.error };
            return { status: 'answered', value: parsed.value, diff: diff.coverage };
        }
    }
}
