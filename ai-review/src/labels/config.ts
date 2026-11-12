import { isMap, isScalar, parseDocument } from 'yaml';
import { z } from 'zod';
import { describeIssues } from '../jev/response.ts';

export const DEFAULT_CONFIG_PATH = '.github/jev-labeler.yml';
export const DEFAULT_ADD_AT = 0.7;
export const DEFAULT_REMOVE_AT = 0.3;

export type Instructions = string | { [key: string]: unknown };

export type LabelRule = {
    name: string;
    color?: string;
    description?: string;
    instructions: Instructions;
    criteria?: { true: string; false: string };
    addAt: number;
    removeAt: number;
};

const threshold = z.number().min(0).max(1);

const RuleFile = z
    .strictObject({
        color: z.string().regex(/^[0-9a-fA-F]{6}$/, 'expected six hex digits without "#"').optional(),
        description: z.string().min(1).max(100).optional(),
        instructions: z.union([z.string().min(1), z.record(z.string(), z.json())]),
        criteria: z.strictObject({ true: z.string().min(1), false: z.string().min(1) }).optional(),
        add_at: threshold.default(DEFAULT_ADD_AT),
        remove_at: threshold.default(DEFAULT_REMOVE_AT),
    })
    .refine((rule) => rule.remove_at <= rule.add_at, {
        path: ['remove_at'],
        message: 'must be at most add_at, or a label could be added and removed by the same answer',
    });

const ConfigFile = z.strictObject({
    labels: z
        .record(z.string().min(1).max(50), RuleFile)
        .refine((labels) => Object.keys(labels).length > 0, 'at least one label is required')
        .refine(
            (labels) => new Set(Object.keys(labels).map((name) => name.toLowerCase())).size === Object.keys(labels).length,
            'label names must differ by more than case, because GitHub treats them as one label',
        ),
});

export type ConfigParse = { ok: true; rules: LabelRule[] } | { ok: false; error: string };

// A hex color such as 5319e7 reads as the number 5.319e10 in YAML, so take its source text.
function restoreColorText(raw: ReturnType<typeof parseDocument>): void {
    const labels = raw.get('labels', true);
    if (!isMap(labels)) return;
    for (const pair of labels.items) {
        if (!isMap(pair.value)) continue;
        const color = pair.value.get('color', true);
        if (isScalar(color) && typeof color.value === 'number' && color.source !== undefined) color.value = color.source;
    }
}

export function parseConfig(text: string): ConfigParse {
    const doc = parseDocument(text);
    const [yamlError] = doc.errors;
    if (yamlError !== undefined) return { ok: false, error: `YAML: ${yamlError.message.split('\n')[0]}` };
    restoreColorText(doc);
    const result = ConfigFile.safeParse(doc.toJS());
    if (!result.success) return { ok: false, error: describeIssues(result.error) };
    const rules = Object.entries(result.data.labels).map(([name, rule]): LabelRule => ({
        name,
        ...(rule.color === undefined ? {} : { color: rule.color.toLowerCase() }),
        ...(rule.description === undefined ? {} : { description: rule.description }),
        instructions: rule.instructions,
        ...(rule.criteria === undefined ? {} : { criteria: rule.criteria }),
        addAt: rule.add_at,
        removeAt: rule.remove_at,
    }));
    return { ok: true, rules };
}

export type ConfigLookup =
    | { kind: 'found'; rules: LabelRule[] }
    | { kind: 'missing'; ref: string }
    | { kind: 'invalid'; ref: string; error: string };

export function lookupConfig(text: string, ref: string): ConfigLookup {
    const parsed = parseConfig(text);
    return parsed.ok ? { kind: 'found', rules: parsed.rules } : { kind: 'invalid', ref, error: parsed.error };
}
