/** Only gopls diagnostics that explicitly identify build exclusion qualify. */
export function goConstraintExcluded(message: string): boolean {
  return /excluded[^\n]*(?:build|GOOS\/GOARCH)/i.test(message);
}
