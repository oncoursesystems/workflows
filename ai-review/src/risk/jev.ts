import { z } from 'zod';
import type { PullRequest } from '../github/pull-request.ts';
import { askJev as ask } from '../jev/ask.ts';
import { noulAnswer, probability, usage, describeIssues } from '../jev/response.ts';
import type { DiffCoverage } from '../jev/state.ts';
import type { JevOptions } from '../jev/transport.ts';
import { globMatcher, type Policy, type SensitiveArea } from './policy.ts';
import { TIERS, type Tier } from './tier.ts';

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
    usage,
});

export type ParsedResponse = { ok: true; verdict: Omit<JevVerdict, 'diff'> } | { ok: false; error: string };

export function parseResponse(body: unknown, askedSensitiveArea: boolean): ParsedResponse {
    const result = ResponseBody.safeParse(body);
    if (!result.success) return { ok: false, error: `unexpected response: ${describeIssues(result.error, 'response')}` };
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

export async function askJev(pr: PullRequest, policy: Policy, options: JevOptions): Promise<JevResult> {
    const isIgnored = globMatcher(policy.ignore);
    const questions = jevQuestions(policy.sensitiveAreas);
    const askedSensitiveArea = 'sensitive_area' in questions;
    const answer = await ask(
        {
            pr,
            files: pr.files.filter((file) => !isIgnored(file.path)),
            questions,
            parse: (body) => {
                const parsed = parseResponse(body, askedSensitiveArea);
                return parsed.ok ? { ok: true, value: parsed.verdict } : parsed;
            },
        },
        options,
    );
    if (answer.status === 'failed') return answer;
    return { status: 'answered', verdict: { ...answer.value, diff: answer.diff } };
}
