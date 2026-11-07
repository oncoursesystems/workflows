import type { ChangedFile, PullRequest } from '../risk/pull-request.ts';
import type { BugKind, Candidate } from './finding.ts';

export type RepoRules = { claudeMd?: string; reviewMd?: string };

const HUNTS: Record<BugKind, string> = {
    correctness:
        'Correctness: logic that saves or shows the wrong data. A wrong condition, a missed null or empty case, ' +
        'an off-by-one, a wrong district or school scope, a wrong join or filter, state that is not reset.',
    contracts:
        'Contracts: breaks between this change and code it does not touch. Callers of a changed method or ' +
        'signature, Ext Direct and Service endpoints and their parameters, Oracle bind order and bind names, ' +
        'Ext class names that must match their file names, config keys and routes that other code reads.',
    security:
        'Security: data visible across districts or schools, a missing role or permission check, server HTML ' +
        'built from user data without encoding, SQL built from user input, secrets or keys in code.',
};

const rulesSection = ({ claudeMd, reviewMd }: RepoRules): string =>
    [
        claudeMd ? `<claude_md>\n${claudeMd}\n</claude_md>` : '',
        reviewMd ? `<review_md>\nRules from the code owners. They override your defaults.\n${reviewMd}\n</review_md>` : '',
    ]
        .filter(Boolean)
        .join('\n\n');

export function finderSystemPrompt(kinds: readonly BugKind[], rules: RepoRules): string {
    return [
        'You review a pull request in an OnCourse repository. You hunt for these kinds of bugs only:',
        kinds.map((kind) => `- ${HUNTS[kind]}`).join('\n'),
        '',
        'The working directory is the repository at the pull request head. Read changed files in full and search ' +
            'the repository for callers and related code before you report anything. You cannot change files.',
        '',
        'Report a candidate only when you can name the file and the line in the new code, and a concrete failure ' +
            'scenario: what a user or caller does, and what goes wrong. Report bugs the pull request introduces or ' +
            'touches. Do not report style, naming, missing tests, or "consider" suggestions.',
        'Severity "important" means the bug can lose, corrupt or expose data, or break a screen or endpoint. ' +
            'Everything else that is still a real bug is "nit".',
        'Lean toward reporting a plausible bug. A separate reviewer checks every candidate before anything is posted.',
        'Return an empty list when you find nothing.',
        '',
        rulesSection(rules),
    ].join('\n');
}

const fileLine = (file: ChangedFile): string =>
    `${file.status} ${file.previousPath ? `${file.previousPath} -> ` : ''}${file.path} (+${file.additions} -${file.deletions})`;

export const PATCH_BUDGET_CHARS = 150_000;

export function diffSection(files: readonly ChangedFile[], budget = PATCH_BUDGET_CHARS): string {
    let used = 0;
    const patches: string[] = [];
    const omitted: string[] = [];
    for (const file of files) {
        const patch = file.patch ? `--- ${file.path}\n${file.patch}` : undefined;
        if (patch === undefined || used + patch.length > budget) {
            omitted.push(file.path);
            continue;
        }
        patches.push(patch);
        used += patch.length;
    }
    return [
        '<changed_files>',
        files.map(fileLine).join('\n'),
        '</changed_files>',
        '<diff>',
        patches.join('\n\n'),
        '</diff>',
        omitted.length > 0 ? `These files have no patch here. Read them in full: ${omitted.join(', ')}` : '',
    ]
        .filter(Boolean)
        .join('\n');
}

export function finderPrompt(pr: PullRequest, files: readonly ChangedFile[], scope: string): string {
    return [
        `Pull request #${pr.number}: ${pr.title}`,
        pr.body ? `<description>\n${pr.body}\n</description>` : '',
        `Review scope: ${scope}.`,
        diffSection(files),
    ]
        .filter(Boolean)
        .join('\n\n');
}

export function verifierSystemPrompt(rules: RepoRules): string {
    return [
        'You check one candidate bug that another reviewer found in a pull request. Your job is to prove it wrong.',
        'The working directory is the repository at the pull request head. Open the code and answer three questions:',
        '1. Does the code at that line do what the claim says?',
        '2. Can the failure scenario actually happen, or does a guard, a caller or a constraint already stop it?',
        '3. Did this pull request introduce it? Use the diff you are given to decide.',
        'Answer real only when the claim holds and the failure can happen. Give a one-sentence reason.',
        '',
        rulesSection(rules),
    ].join('\n');
}

export function verifierPrompt(pr: PullRequest, files: readonly ChangedFile[], candidate: Candidate): string {
    return [
        `Pull request #${pr.number}: ${pr.title}`,
        '<candidate>',
        `File: ${candidate.file}:${candidate.line}`,
        `Claim: ${candidate.claim}`,
        `Failure scenario: ${candidate.failureScenario}`,
        '</candidate>',
        diffSection(files.filter((file) => file.path === candidate.file)),
    ].join('\n');
}
