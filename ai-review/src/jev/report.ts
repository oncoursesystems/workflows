import type { DiffCoverage } from './state.ts';

export const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

export const percent = (p: number): string => `${(p * 100).toFixed(1)}%`;

export const DIFF_NOTE: Record<DiffCoverage, string> = {
    complete: 'Jev saw the whole diff.',
    truncated: 'The diff was truncated to fit the model context.',
    omitted: 'The diff was too large for the model context, so Jev saw only the file list.',
};
