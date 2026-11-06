import type { Classification } from './classify.ts';
import type { JevResult } from './jev.ts';
import { TIERS, type Tier } from './tier.ts';

const TIER_TITLE: Record<Tier, string> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

export const checkTitle = (tier: Tier): string => TIER_TITLE[tier];

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

const percent = (p: number): string => `${(p * 100).toFixed(1)}%`;

function jevSection(jev: JevResult): string[] {
    switch (jev.status) {
        case 'skipped':
            return ['Jev was not asked.'];
        case 'failed':
            return [`Jev failed: ${jev.error}`];
        case 'answered': {
            const { verdict } = jev;
            const diffNote = {
                complete: 'Jev saw the whole diff.',
                truncated: 'The diff was truncated to fit the model context.',
                omitted: 'The diff was too large for the model context, so Jev saw only the file list.',
            }[verdict.diff];
            return [
                `Model \`${verdict.model}\`, ${verdict.inputTokens.toLocaleString('en-US')} input tokens. ${diffNote}`,
                '',
                '| Jev tier | Probability |',
                '| --- | --- |',
                ...TIERS.map((tier) => `| ${tier} | ${percent(verdict.tierProbabilities[tier])} |`),
                '',
                `Access change: ${percent(verdict.accessChange)}.`,
                verdict.sensitiveArea === null
                    ? 'Sensitive area: not asked, because the review policy names none.'
                    : `Sensitive area: ${percent(verdict.sensitiveArea)}.`,
            ];
        }
    }
}

export function renderSummary(classification: Classification): string {
    const { tier, reasons, jev, countedLines } = classification;
    const reasonRows =
        reasons.length === 0
            ? ['No rule raised the tier above low.']
            : [
                  '| Source | Tier | Reason |',
                  '| --- | --- | --- |',
                  ...reasons.map((r) => `| ${r.source} | ${r.tier} | ${cell(r.text)} |`),
              ];
    return [
        `## ${TIER_TITLE[tier]}`,
        '',
        `${countedLines} changed lines outside ignored paths.`,
        '',
        ...reasonRows,
        '',
        '### Jev',
        '',
        ...jevSection(jev),
        '',
        'Agree? Add the `risk-ok` label. Disagree? Add `risk-should-be:low`, `risk-should-be:medium` or `risk-should-be:high`.',
        '',
    ].join('\n');
}
