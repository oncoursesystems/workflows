import type { Tier } from '../risk/tier.ts';
import { BUG_KINDS, type BugKind } from './finding.ts';

export const MODELS = {
    sonnet: 'claude-sonnet-5-5',
    opus: 'claude-opus-5-5',
    haiku: 'claude-haiku-5-5',
} as const;

export type FinderSpec = { kinds: BugKind[]; model: string };

export function findersFor(tier: Tier): FinderSpec[] {
    switch (tier) {
        case 'low':
            return [{ kinds: [...BUG_KINDS], model: MODELS.sonnet }];
        case 'medium':
            return BUG_KINDS.map((kind) => ({ kinds: [kind], model: MODELS.sonnet }));
        case 'high':
            return BUG_KINDS.map((kind) => ({ kinds: [kind], model: MODELS.opus }));
    }
}

export const VERIFIER_MODEL = MODELS.haiku;
