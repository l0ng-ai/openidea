/**
 * Synthetic output of a full-screen TUI (agent CLIs such as Claude Code or Grok) for the
 * performance harness: every frame repaints the whole screen and retitles the window, while
 * only the spinner row actually changes. That is the pattern that made typing lag (#2239).
 */

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

/** Fills `width` columns with `text`, repeated and cut. */
function fill(text: string, width: number): string {
  return text.repeat(Math.ceil(width / text.length)).slice(0, width);
}

/** Frame `n` of a `cols`×`rows` screen: alt screen, cursor home, every row rewritten. */
export function sampleTuiFrame(n: number, cols: number, rows: number): string {
  const inner = Math.max(cols - 6, 1);
  const spinner = SPINNER[n % SPINNER.length];
  let out = `\x1b]0;${spinner} Thinking - sample\x07\x1b[?25l\x1b[H`;
  const line = (row: number, text: string) => {
    out += `\x1b[${row};1H\x1b[2K${text}\x1b[0m`;
  };
  line(1, `${rgb(130, 130, 140)}  ~/projects/sample`);
  for (let r = 2; r < rows - 6; r++) {
    line(r, `${rgb(200, 200, 205)}  ${fill(`Line ${r - 1} of the answer, with words and \`code\` in it. `, inner)}`);
  }
  line(rows - 6, `${rgb(220, 180, 90)}  ${spinner} Thinking… ${(n / 10).toFixed(1)}s ${rgb(110, 110, 120)}[stop]`);
  line(rows - 4, `${rgb(90, 90, 100)}  ╭${"─".repeat(inner)}╮`);
  line(
    rows - 3,
    `${rgb(90, 90, 100)}  │ ${rgb(200, 200, 205)}❯${" ".repeat(Math.max(inner - 2, 0))}${rgb(90, 90, 100)}│`,
  );
  line(rows - 2, `${rgb(90, 90, 100)}  ╰${"─".repeat(inner)}╯`);
  line(rows, `${rgb(150, 150, 160)}  Enter:send  │  Shift+Tab:mode  │  Ctrl+c:cancel`);
  return `${out}\x1b[${rows - 3};6H\x1b[?25h`;
}

/** Enters the alternate screen; written once before the first frame. */
export const SAMPLE_TUI_START = "\x1b[?1049h";
/** Leaves it again. */
export const SAMPLE_TUI_END = "\x1b[?1049l";
