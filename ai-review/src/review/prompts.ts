import type { ChangedFile, PullRequest } from '../github/pull-request.ts';
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

const SEVERITY_RULE =
    'Severity "important" means the bug can lose, corrupt or expose data, show one user another user\'s data, ' +
    'or break a screen or endpoint. REVIEW.md, when present, defines Important for this repository and overrides ' +
    'this default. Every other real bug is "minor".';

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
        SEVERITY_RULE,
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

export const FINDER_RETRY_NOTE =
    'Your last review of this pull request returned without looking at any code. Read the changed files in full ' +
    'and search for related code before you answer.';

export const MERGER_SYSTEM_PROMPT = [
    'Several reviewers looked at the same pull request on their own, so some of their candidate bugs may be the same ' +
        'defect reported twice, at different lines or as a different kind.',
    'Group candidates only when one edit in one place fixes all of them, such as two reports of one missing guard ' +
        'that cite the guard and its caller. The same mistake made in two methods is two defects, because each ' +
        'method needs its own fix. Two different bugs in the same code are not the same defect either.',
    'For each group, name the one edit that fixes every candidate in it. If you cannot name a single edit in a ' +
        'single place, it is not a group. Return only groups of 2 or more candidate numbers. When you are not sure, ' +
        'do not group them. Answer from the list. You do not need to open files.',
].join('\n');

export function mergerPrompt(candidates: readonly Candidate[]): string {
    return candidates
        .map((candidate, index) =>
            [`<candidate number="${index}">`, `${candidate.file}:${candidate.line} (${candidate.kind})`, candidate.claim, '</candidate>'].join('\n'),
        )
        .join('\n');
}

export function verifierSystemPrompt(rules: RepoRules): string {
    return [
        'You check one candidate bug that another reviewer found in a pull request. Your job is to prove it wrong.',
        'The working directory is the repository at the pull request head. Open the code and answer these questions:',
        '1. Does the code at that line do what the claim says?',
        '2. Can the failure scenario actually happen, or does a guard, a caller or a constraint already stop it?',
        '3. Did this pull request introduce it? The diff covers every file the pull request changed. Its removed ' +
            'lines show how the code worked before, including code the pull request deleted from other files.',
        '4. How severe is it?',
        SEVERITY_RULE,
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
        diffSection([...files].sort((a, b) => Number(b.path === candidate.file) - Number(a.path === candidate.file))),
    ].join('\n');
}
