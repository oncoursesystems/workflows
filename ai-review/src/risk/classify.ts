import type { JevResult } from './jev.ts';
import { globMatcher, policyOf, type Policy, type PolicyLookup } from './policy.ts';
import type { PullRequest } from '../github/pull-request.ts';
import { TIERS, maxTier, type Tier } from './tier.ts';

export type Reason = { source: 'policy' | 'size' | 'jev' | 'flag' | 'fallback'; tier: Tier; text: string };

export type Classification = {
    tier: Tier;
    reasons: Reason[];
    jev: JevResult;
    countedLines: number;
    truncatedDiff: boolean;
};

export const ACCESS_CHANGE_THRESHOLD = 0.5;
export const SENSITIVE_AREA_THRESHOLD = 0.5;

const HUMAN_REVIEW_TIER: Tier = 'medium';

type RuleInput = {
    pr: PullRequest;
    lookup: PolicyLookup;
    policy: Policy;
    jev: JevResult;
    countedLines: number;
};

type Rule = (input: RuleInput) => Reason[];

const percent = (p: number): string => `${Math.round(p * 100)}%`;

const policyStatus: Rule = ({ lookup }) => {
    switch (lookup.kind) {
        case 'found':
            return [];
        case 'missing':
            return [{ source: 'policy', tier: 'low', text: `No review policy was found on \`${lookup.ref}\`.` }];
        case 'invalid':
            return [
                {
                    source: 'policy',
                    tier: HUMAN_REVIEW_TIER,
                    text: `The review policy on \`${lookup.ref}\` is invalid, so it was ignored: ${lookup.error}`,
                },
            ];
    }
};

const minimumRiskByPath: Rule = ({ pr, policy }) =>
    TIERS.flatMap((tier) =>
        (policy.minimumRisk[tier] ?? []).flatMap((pattern): Reason[] => {
            const matches = globMatcher([pattern]);
            const files = pr.files.filter(
                (file) => matches(file.path) || (file.previousPath !== undefined && matches(file.previousPath)),
            );
            const [first] = files;
            if (first === undefined) return [];
            const others = files.length - 1;
            const subject =
                others === 0 ? `\`${first.path}\` matches` : `\`${first.path}\` and ${others} more file${others > 1 ? 's' : ''} match`;
            return [{ source: 'policy', tier, text: `${subject} \`${pattern}\`.` }];
        }),
    );

const size: Rule = ({ policy, countedLines }) =>
    countedLines > policy.lowMaxChangedLines
        ? [
              {
                  source: 'size',
                  tier: 'medium',
                  text: `${countedLines} changed lines outside ignored paths, above the low-risk limit of ${policy.lowMaxChangedLines}.`,
              },
          ]
        : [];

const jevTier: Rule = ({ jev }) =>
    jev.status === 'answered'
        ? [
              {
                  source: 'jev',
                  tier: jev.verdict.tier,
                  text: `Jev chose ${jev.verdict.tier} (${percent(jev.verdict.tierProbabilities[jev.verdict.tier])}).`,
              },
          ]
        : [];

const accessChange: Rule = ({ jev }) =>
    jev.status === 'answered' && jev.verdict.accessChange >= ACCESS_CHANGE_THRESHOLD
        ? [
              {
                  source: 'flag',
                  tier: 'high',
                  text: `Jev says the change alters who can see or change which records (${percent(jev.verdict.accessChange)}).`,
              },
          ]
        : [];

const sensitiveArea: Rule = ({ jev }) => {
    if (jev.status !== 'answered' || jev.verdict.sensitiveArea === null) return [];
    const p = jev.verdict.sensitiveArea;
    return p >= SENSITIVE_AREA_THRESHOLD
        ? [
              {
                  source: 'flag',
                  tier: HUMAN_REVIEW_TIER,
                  text: `Jev says the change alters a sensitive area in the review policy (${percent(p)}).`,
              },
          ]
        : [];
};

const fallback: Rule = ({ jev }) =>
    jev.status === 'failed'
        ? [{ source: 'fallback', tier: HUMAN_REVIEW_TIER, text: `Jev failed, so a person reviews it: ${jev.error}` }]
        : [];

const RULES: readonly Rule[] = [policyStatus, minimumRiskByPath, size, jevTier, accessChange, sensitiveArea, fallback];

export function countChangedLines(pr: PullRequest, policy: Policy): number {
    const isIgnored = globMatcher(policy.ignore);
    return pr.files
        .filter((file) => !isIgnored(file.path))
        .reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

export function classify(pr: PullRequest, lookup: PolicyLookup, jev: JevResult): Classification {
    const policy = policyOf(lookup);
    const input: RuleInput = { pr, lookup, policy, jev, countedLines: countChangedLines(pr, policy) };
    const reasons = RULES.flatMap((rule) => rule(input));
    return {
        tier: reasons.reduce<Tier>((tier, reason) => maxTier(tier, reason.tier), 'low'),
        reasons,
        jev,
        countedLines: input.countedLines,
        truncatedDiff: jev.status === 'answered' && jev.verdict.diff !== 'complete',
    };
}
