import { parseDocument } from 'yaml';
import { z } from 'zod';
import { describeIssues } from '../jev/response.ts';

export const DEFAULT_CONFIG_PATH = '.github/sentry-fix.yml';
export const PERIODS = ['24h', '7d', '14d'] as const;
export type Period = (typeof PERIODS)[number];
export const VERSION_PLACEHOLDER = '{version}';

export type ProjectConfig = {
    slug: string;
    description: string;
    roots: string[];
};

export type AppConfig = {
    name: string;
    release: string;
    projects: string[];
};

export type SentryFixConfig = {
    limit: number;
    environment: string;
    period: Period;
    projects: ProjectConfig[];
    apps: AppConfig[];
};

const root = z
    .string()
    .min(1)
    .transform((path) => path.replace(/\/+$/, '') || '.')
    .refine(
        (path) => !path.startsWith('/') && !path.includes('\\') && !/[*?[\]{}]/.test(path) && !path.split('/').includes('..'),
        'must be a directory relative to the repository root, without "..", globs or backslashes',
    );

const ProjectFile = z.strictObject({
    slug: z.string().min(1),
    description: z.string().min(1),
    roots: z.array(root).min(1),
});

const AppFile = z.strictObject({
    name: z.string().min(1),
    release: z.string().includes(VERSION_PLACEHOLDER, { message: `must contain ${VERSION_PLACEHOLDER}` }),
    projects: z.array(z.string().min(1)).min(1),
});

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const ConfigFile = z
    .strictObject({
        limit: z.number().int().min(1).max(20).default(5),
        environment: z.string().min(1).default('production'),
        period: z.enum(PERIODS).default('7d'),
        projects: z.array(ProjectFile).min(1),
        apps: z.array(AppFile).default([]),
    })
    .refine((config) => unique(config.projects.map((project) => project.slug)), {
        path: ['projects'],
        message: 'project slugs must be unique',
    })
    .refine((config) => unique(config.apps.map((app) => app.name)), { path: ['apps'], message: 'app names must be unique' })
    .superRefine((config, ctx) => {
        const slugs = new Set(config.projects.map((project) => project.slug));
        config.apps.forEach((app, index) => {
            for (const slug of app.projects.filter((slug) => !slugs.has(slug))) {
                ctx.addIssue({ code: 'custom', path: ['apps', index, 'projects'], message: `${slug} is not one of the projects` });
            }
        });
    });

export type ConfigParse = { ok: true; config: SentryFixConfig } | { ok: false; error: string };

export function parseConfig(text: string): ConfigParse {
    const doc = parseDocument(text);
    const [yamlError] = doc.errors;
    if (yamlError !== undefined) return { ok: false, error: `YAML: ${yamlError.message.split('\n')[0]}` };
    const result = ConfigFile.safeParse(doc.toJS());
    if (!result.success) return { ok: false, error: describeIssues(result.error) };
    return { ok: true, config: result.data };
}

export const projectOf = (config: SentryFixConfig, slug: string): ProjectConfig | undefined =>
    config.projects.find((project) => project.slug === slug);

export const appOf = (config: SentryFixConfig, name: string): AppConfig | undefined => config.apps.find((app) => app.name === name);

export const renderRelease = (app: AppConfig, version: string): string => app.release.replaceAll(VERSION_PLACEHOLDER, version);
