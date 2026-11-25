type PreferredWidths = Partial<Record<"lines" | "branches", number>>;

const KEY = "openidea.coverage.columns";

export function readCoverageWidths(): PreferredWidths {
  try {
    const widths = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const valid = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);
    return { lines: valid(widths?.lines), branches: valid(widths?.branches) };
  } catch {
    return {};
  }
}

export function saveCoverageWidths(widths: PreferredWidths) {
  try {
    localStorage.setItem(KEY, JSON.stringify(widths));
  } catch {
    /* Storage may be unavailable. */
  }
}

export function coverageColumns(pane: number, hasBranches: boolean, preferred: PreferredWidths) {
  const min = Math.min(52, Math.floor(pane / 5));
  const count = hasBranches ? 2 : 1;
  // Reserve space for the tree label, its icons and indentation, and the table gutters.
  const budget = Math.max(count * min, pane - 132);
  const auto = Math.round(pane < 360 ? Math.min(pane * 0.23, 65) : Math.min(pane * 0.29, 128));
  const lines = Math.min(budget, Math.max(min, preferred.lines ?? auto));
  const branches = hasBranches ? Math.min(budget, Math.max(min, preferred.branches ?? auto)) : 0;
  if (lines + branches <= budget) return { min, budget, widths: { lines, branches } };

  // Fit saved widths proportionally on a smaller dock without changing the saved layout.
  const room = budget - min * count;
  const fittedLines = min + Math.round(((lines - min) / (lines + branches - min * count)) * room);
  return { min, budget, widths: { lines: fittedLines, branches: budget - fittedLines } };
}
