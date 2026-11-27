/** Notebook ↔ Python script in the `# %%` cell format (VS Code, Jupytext, PyCharm). */

export interface ScriptCell {
  cellType: string;
  source: string;
}

const MARKER = /^#\s?%%(.*)$/;
// Lines a plain `python` can't run: IPython magics, shell escapes, help.
const IPYTHON_LINE = /^\s*[%!?]/;

function commented(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `# ${line}` : "#"))
    .join("\n");
}

function codeCell(source: string): string {
  // A cell magic (`%%bash`, `%%html`) makes the whole cell something other than Python.
  if (source.trimStart().startsWith("%%")) return commented(source);
  return source
    .split("\n")
    .map((line) => (IPYTHON_LINE.test(line) ? `# ${line}` : line))
    .join("\n");
}

export function notebookToScript(cells: ScriptCell[]): string {
  const parts = cells.map((cell) => {
    const source = cell.source.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (cell.cellType === "code") return source ? `# %%\n${codeCell(source)}` : "# %%";
    const kind = cell.cellType === "markdown" ? "markdown" : "raw";
    return source ? `# %% [${kind}]\n${commented(source)}` : `# %% [${kind}]`;
  });
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

function uncommented(lines: string[]): string[] {
  return lines.map((line) => line.replace(/^#( |$)/, ""));
}

function trimBlank(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start++;
  while (end > start && !lines[end - 1]!.trim()) end--;
  return lines.slice(start, end).join("\n");
}

export function scriptToCells(text: string): ScriptCell[] {
  const cells: ScriptCell[] = [];
  let type = "code";
  let lines: string[] = [];
  let marked = false;
  const flush = () => {
    const body = type === "code" ? lines : uncommented(lines);
    const source = trimBlank(body);
    // Text before the first marker is a cell only when it has content.
    if (marked || source) cells.push({ cellType: type, source });
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = MARKER.exec(line);
    if (!marker) {
      lines.push(line);
      continue;
    }
    flush();
    const rest = marker[1]!.trim().toLowerCase();
    type = /^\[?(markdown|md)\]?/.test(rest) ? "markdown" : /^\[raw\]/.test(rest) ? "raw" : "code";
    lines = [];
    marked = true;
  }
  flush();
  return cells;
}

/** nbformat lines: each but the last keeps its `\n`. */
function sourceLines(source: string): string[] {
  if (!source) return [];
  const lines = source.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

export function scriptToNotebook(text: string, newId: () => string = () => crypto.randomUUID()): string {
  const cells = scriptToCells(text).map(({ cellType, source }) => ({
    cell_type: cellType,
    id: newId(),
    metadata: {},
    source: sourceLines(source),
    ...(cellType === "code" ? { execution_count: null, outputs: [] } : {}),
  }));
  const notebook = {
    cells,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return `${JSON.stringify(notebook, null, 1)}\n`;
}

/** Cells of an `.ipynb` file's text; throws unless it is nbformat 4. */
export function notebookCells(text: string): ScriptCell[] {
  const root: unknown = JSON.parse(text);
  const nb = root as { nbformat?: unknown; cells?: unknown };
  if (!root || typeof root !== "object" || nb.nbformat !== 4 || !Array.isArray(nb.cells))
    throw new Error("Only nbformat 4 notebooks can be converted");
  return nb.cells.map((cell: { cell_type?: unknown; source?: unknown }) => ({
    cellType: typeof cell.cell_type === "string" ? cell.cell_type : "raw",
    source: Array.isArray(cell.source) ? cell.source.join("") : typeof cell.source === "string" ? cell.source : "",
  }));
}
