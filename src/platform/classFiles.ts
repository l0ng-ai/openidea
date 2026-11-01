/** Compiled Java files are resolved before the binary viewer, at every opening entry. */
export function isClassFile(path: string): boolean {
  return !path.startsWith("jdt:") && /\.class$/i.test(path);
}

export function classFileBreakpointReason(path: string): string | null {
  return isClassFile(path) ? "Breakpoints are not supported in output classes without source code." : null;
}
