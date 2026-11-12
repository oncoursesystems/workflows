import { z } from 'zod';

export const probability = z.number().min(0).max(1);
export const noulAnswer = z.object({ type: z.literal('noul'), noul: probability });
export const usage = z.object({ input_tokens: z.number().int().nonnegative() });

export const describeIssues = (error: z.ZodError, root = 'file'): string =>
    error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : root}: ${issue.message}`).join('; ');
