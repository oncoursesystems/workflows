import { DIFF_NOTE, cell, percent } from '../jev/report.ts';
import type { LabelRun } from './run.ts';

export function renderSummary(run: Extract<LabelRun, { status: 'answered' }>): string {
    const rows = run.decisions.map(
        ({ rule, probability, action }) =>
            `| ${cell(rule.name)} | ${percent(probability)} | ${percent(rule.addAt)} | ${percent(rule.removeAt)} | ${action} |`,
    );
    return [
        '## AI labels',
        '',
        `Model \`${run.model}\`, ${run.inputTokens.toLocaleString('en-US')} input tokens. ${DIFF_NOTE[run.diff]}`,
        '',
        '| Label | Probability | Add at | Remove at | Action |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
        '',
    ].join('\n');
}
