/**
 * Token estimate for budgeting slices. Model tokenizers differ; this is a deliberate
 * approximation (about 3.8 characters per token for mixed prose and identifiers),
 * calibrated conservatively so a slice under budget here stays under budget in practice.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}
