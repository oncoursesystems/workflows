import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Tier } from './tier.ts';

export type SensitiveArea = { name: string; covers: string };

export type Policy = {
    minimumRisk: Partial<Record<Tier, string[]>>;
    lowMaxChangedLines: number;
    ignore: string[];
    sensitiveAreas: SensitiveArea[];
    trustedTeam?: string;
    policyAdmins?: string;
};

export const EMPTY_POLICY: Policy = { minimumRisk: {}, lowMaxChangedLines: 400, ignore: [], sensitiveAreas: [] };

export type PolicyLookup =
    | { kind: 'found'; policy: Policy }
    | { kind: 'missing'; ref: string }
    | { kind: 'invalid'; ref: string; error: string };

export const policyOf = (lookup: PolicyLookup): Policy =>
    lookup.kind === 'found' ? lookup.policy : EMPTY_POLICY;

const globs = z.array(z.string().min(1));

const PolicyFile = z.strictObject({
    minimum_risk: z
        .strictObject({ low: globs.default([]), medium: globs.default([]), high: globs.default([]) })
        .default({ low: [], medium: [], high: [] }),
    low_max_changed_lines: z.number().int().nonnegative().default(EMPTY_POLICY.lowMaxChangedLines),
    ignore: globs.default([]),
    sensitive_areas: z
        .array(z.strictObject({ name: z.string().min(1), covers: z.string().min(1) }))
        .default([]),
    trusted_team: z.string().min(1).optional(),
    policy_admins: z.string().min(1).optional(),
});

export type PolicyParse = { ok: true; policy: Policy } | { ok: false; error: string };

export function parsePolicy(text: string): PolicyParse {
    let raw: unknown;
    try {
        raw = parseYaml(text);
    } catch (error) {
        return { ok: false, error: `YAML: ${(error as Error).message.split('\n')[0]}` };
    }
    const result = PolicyFile.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => {
            const at = issue.path.length > 0 ? issue.path.join('.') : 'file';
            return `${at}: ${issue.message}`;
        });
        return { ok: false, error: issues.join('; ') };
    }
    const file = result.data;
    const policy: Policy = {
        minimumRisk: file.minimum_risk,
        lowMaxChangedLines: file.low_max_changed_lines,
        ignore: file.ignore,
        sensitiveAreas: file.sensitive_areas,
    };
    if (file.trusted_team !== undefined) policy.trustedTeam = file.trusted_team;
    if (file.policy_admins !== undefined) policy.policyAdmins = file.policy_admins;
    return { ok: true, policy };
}

export const missingPolicy = (ref: string): PolicyLookup => ({ kind: 'missing', ref });

export function lookupPolicy(text: string, ref: string): PolicyLookup {
    const parsed = parsePolicy(text);
    return parsed.ok ? { kind: 'found', policy: parsed.policy } : { kind: 'invalid', ref, error: parsed.error };
}

export type PathMatcher = (path: string) => boolean;

export const globMatcher = (patterns: readonly string[]): PathMatcher =>
    patterns.length === 0 ? () => false : picomatch([...patterns], { dot: true });
