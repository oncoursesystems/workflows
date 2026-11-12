import { isAlreadyExists, isNotFound, type Octokit, type RepoRef } from './client.ts';

export type LabelSpec = { name: string; color?: string; description?: string };

export type LabelChange = { add: string[]; remove: string[] };

// GitHub compares label names case-insensitively.
export const hasLabel = (labels: readonly string[], name: string): boolean => {
    const lower = name.toLowerCase();
    return labels.some((label) => label.toLowerCase() === lower);
};

export const missingLabels = (existing: readonly string[], specs: readonly LabelSpec[]): LabelSpec[] =>
    specs.filter((spec) => !hasLabel(existing, spec.name));

export async function ensureLabels(octokit: Octokit, repo: RepoRef, specs: readonly LabelSpec[]): Promise<void> {
    const existing = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, { ...repo, per_page: 100 });
    for (const spec of missingLabels(existing.map((l) => l.name), specs)) {
        try {
            await octokit.rest.issues.createLabel({
                ...repo,
                name: spec.name,
                ...(spec.color === undefined ? {} : { color: spec.color }),
                ...(spec.description === undefined ? {} : { description: spec.description }),
            });
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
        }
    }
}

export async function listLabelNames(octokit: Octokit, repo: RepoRef, number: number): Promise<string[]> {
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, { ...repo, issue_number: number, per_page: 100 });
    return labels.map((label) => label.name);
}

export async function applyLabelChange(octokit: Octokit, repo: RepoRef, number: number, change: LabelChange): Promise<void> {
    if (change.add.length > 0) {
        await octokit.rest.issues.addLabels({ ...repo, issue_number: number, labels: change.add });
    }
    for (const name of change.remove) {
        try {
            await octokit.rest.issues.removeLabel({ ...repo, issue_number: number, name });
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
    }
}
