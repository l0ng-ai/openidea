/** CLI repetition counts must be validated before any build or process launch. */
export function countOption(name: string, raw: string, minimum: 0 | 1): number {
  const value = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }
  return value;
}
