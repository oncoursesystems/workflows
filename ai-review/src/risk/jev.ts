import { z } from 'zod';
import { globMatcher, type Policy, type SensitiveArea } from './policy.ts';
import type { ChangedFile, PullRequest } from './pull-request.ts';
import { TIERS, type Tier } from './tier.ts';

export const DEFAULT_JEV_MODEL = 'jev-1.14.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_QUESTION_CONTEXT_TOKENS = 32_000;
const QUESTION_HEADROOM_TOKENS = 8_500;
const MEASURED_CHARS_PER_TOKEN = 3.4;
export const STATE_BUDGET_CHARS = Math.floor(
    (JEV_QUESTION_CONTEXT_TOKENS - QUESTION_HEADROOM_TOKENS) * MEASURED_CHARS_PER_TOKEN,
);
const REQUEST_TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;
const BASE_BACKOFF_MS = 2_000;
const RETRYABLE_STATUSES = new Set([429, 529]);
const ERROR_TEXT_LIMIT = 500;
const CONTEXT_RETRIES = 6;
const MIN_DIFF_CHARS = 1_000;

export type DiffCoverage = 'complete' | 'truncated' | 'omitted';

export type JevVerdict = {
    model: string;
    tier: Tier;
    tierProbabilities: Record<Tier, number>;
    accessChange: number;
    sensitiveArea: number | null;
    inputTokens: number;
    diff: DiffCoverage;
};

export type JevResult =
    | { status: 'answered'; verdict: JevVerdict }
    | { status: 'failed'; error: string }
    | { status: 'skipped' };

const TIER_QUESTION = {
    type: 'choice',
    instructions:
        'How much human review does the pull request described by `pull_request`, `files`, and `diff` need ' +
        'before merge, judged by what could go wrong for school districts if the change is wrong?',
    criteria: {
        low:
            'Little review: documentation, Claude skills under `.claude/`, test-only changes and test tooling ' +
            'under `tests/`, Sass or CSS, copy text, or additive code behind an existing feature flag.',
        medium:
            'Normal review: everything that is neither low nor high, including large features, performance work, ' +
            'data fixes, server code, front-end logic, and configuration.',
        high:
            'Careful review, only for: authentication or permissions (SAML, OAuth, FIDO2, Duo, login-as-user, ' +
            'role checks), the district or school scoping that limits users to their own records, CI workflows, ' +
            'or deploy scripts. Size, performance, and new features alone never make a change high.',
    },
} as const;

const ACCESS_CHANGE_QUESTION = {
    type: 'noul',
    instructions:
        'Does the change in `diff` alter the rules that decide which users may see or change which records?',
    criteria: {
        true:
            'It changes sign-in or session handling, a role or permission check, or the district or school ' +
            'scoping that limits a user to their own organization records.',
        false:
            'Those rules are unchanged. Filters, searches, and selections a user makes inside screens they can ' +
            'already open are not access changes, and neither are test tools or developer tooling.',
    },
} as const;

const sensitiveAreaQuestion = (areas: readonly SensitiveArea[]) => ({
    type: 'noul',
    instructions: {
        task:
            'Does the change in `diff` alter how any of these sensitive areas is calculated, saved, deleted, or ' +
            'sent? A feature flag around the change does not matter.',
        sensitive_areas: areas.map((area) => ({ name: area.name, covers: area.covers })),
    },
    criteria: {
        true: 'The change alters how one of the sensitive areas is calculated, saved, deleted, or sent.',
        false:
            'No sensitive area changes behavior. Copy text, styling, and tests inside these modules are not ' +
            'behavior changes.',
    },
});

export const jevQuestions = (areas: readonly SensitiveArea[]) => ({
    tier: TIER_QUESTION,
    access_change: ACCESS_CHANGE_QUESTION,
    ...(areas.length === 0 ? {} : { sensitive_area: sensitiveAreaQuestion(areas) }),
});

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

const omittedDiff = (files: readonly ChangedFile[]): DiffText => ({
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

const probability = z.number().min(0).max(1);
const noulAnswer = z.object({ type: z.literal('noul'), noul: probability });
const ResponseBody = z.object({
    model: z.string(),
    answers: z.object({
        tier: z.object({
            type: z.literal('choice'),
            choice: z.enum(TIERS),
            probabilities: z.object({ low: probability, medium: probability, high: probability }),
        }),
        access_change: noulAnswer,
        sensitive_area: noulAnswer.optional(),
    }),
    usage: z.object({ input_tokens: z.number().int().nonnegative() }),
});

export type ParsedResponse = { ok: true; verdict: Omit<JevVerdict, 'diff'> } | { ok: false; error: string };

export function parseResponse(body: unknown, askedSensitiveArea: boolean): ParsedResponse {
    const result = ResponseBody.safeParse(body);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
        return { ok: false, error: `unexpected response: ${issues.join('; ')}` };
    }
    const { model, answers, usage } = result.data;
    if (askedSensitiveArea && answers.sensitive_area === undefined) {
        return { ok: false, error: 'unexpected response: answers.sensitive_area is missing' };
    }
    return {
        ok: true,
        verdict: {
            model,
            tier: answers.tier.choice,
            tierProbabilities: answers.tier.probabilities,
            accessChange: answers.access_change.noul,
            sensitiveArea: askedSensitiveArea ? (answers.sensitive_area?.noul ?? null) : null,
            inputTokens: usage.input_tokens,
        },
    };
}

export type JevOptions = {
    apiKey: string;
    model: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
};

type Attempt =
    | { kind: 'ok'; body: unknown }
    | { kind: 'too-long' }
    | { kind: 'error'; error: string };

const truncate = (text: string): string =>
    text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT)}...` : text;

export function retryDelayMs(retryAfter: string | null, attempt: number): number {
    if (retryAfter !== null) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        const date = Date.parse(retryAfter);
        if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    }
    return BASE_BACKOFF_MS * 2 ** attempt;
}

async function post(body: string, options: JevOptions): Promise<Attempt> {
    const doFetch = options.fetch ?? fetch;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
            response = await doFetch(ENDPOINT, {
                method: 'POST',
                headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
                body,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            const name = (error as Error).name;
            if (name === 'TimeoutError') return { kind: 'error', error: `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` };
            return { kind: 'error', error: `request failed: ${truncate((error as Error).message)}` };
        }
        if (response.ok) {
            try {
                return { kind: 'ok', body: await response.json() };
            } catch {
                return { kind: 'error', error: 'response was not JSON' };
            }
        }
        const text = await response.text().catch(() => '');
        if (response.status === 400 && text.includes('max_tokens_exceeded')) return { kind: 'too-long' };
        if (RETRYABLE_STATUSES.has(response.status) && attempt + 1 < ATTEMPTS) {
            await sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
            continue;
        }
        return { kind: 'error', error: `HTTP ${response.status}: ${truncate(text)}` };
    }
}

export async function askJev(pr: PullRequest, policy: Policy, options: JevOptions): Promise<JevResult> {
    const isIgnored = globMatcher(policy.ignore);
    const files = pr.files.filter((file) => !isIgnored(file.path));
    const questions = jevQuestions(policy.sensitiveAreas);
    const askedSensitiveArea = 'sensitive_area' in questions;
    const empty: DiffText = { text: '', coverage: 'complete' };
    const metadata = JSON.stringify(buildState(pr, { entries: [], total: 0 }, empty)).length;
    let fileBudget = STATE_BUDGET_CHARS - metadata;
    let fileList = fileListThatFits(files, fileBudget);
    const request = (diff: DiffText) =>
        JSON.stringify({ model: options.model, state: buildState(pr, fileList, diff), questions });

    const withoutDiff = JSON.stringify(buildState(pr, fileList, empty)).length;
    let diff = diffOfWholeFilesThatFit(files, STATE_BUDGET_CHARS - withoutDiff);
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
            const parsed = parseResponse(attempt.body, askedSensitiveArea);
            if (!parsed.ok) return { status: 'failed', error: parsed.error };
            return { status: 'answered', verdict: { ...parsed.verdict, diff: diff.coverage } };
        }
    }
}
