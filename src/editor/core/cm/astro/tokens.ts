/** External tokens of `astro.grammar`: the frontmatter fences, its script and the template. */
import { ExternalTokenizer, type InputStream } from "@lezer/lr";
import { FrontmatterFence, FrontmatterScript, Template } from "./parser.terms";

const NEWLINE = 10,
  CARRIAGE_RETURN = 13,
  SPACE = 32,
  TAB = 9,
  DASH = 45;

const isBlank = (ch: number) => ch === SPACE || ch === TAB;
const isSpace = (ch: number) => isBlank(ch) || ch === NEWLINE || ch === CARRIAGE_RETURN;

/**
 * The end of a fence line starting at `offset` (a line holding `---` and
 * blanks, the Astro compiler allows both around it), or -1 when the line is
 * something else.
 */
function fenceEnd(input: InputStream, offset: number): number {
  let i = offset;
  while (isBlank(input.peek(i))) i++;
  if (input.peek(i) !== DASH || input.peek(i + 1) !== DASH || input.peek(i + 2) !== DASH) return -1;
  i += 3;
  while (isBlank(input.peek(i))) i++;
  const ch = input.peek(i);
  return ch === NEWLINE || ch === CARRIAGE_RETURN || ch === -1 ? i : -1;
}

export const component = new ExternalTokenizer((input, stack) => {
  if (input.next === -1) return;
  const inFrontmatter = stack.canShift(FrontmatterScript);
  if (inFrontmatter || stack.canShift(FrontmatterFence)) {
    // The opening fence may follow blank lines at the start of the file.
    let start = 0;
    if (!inFrontmatter) while (isSpace(input.peek(start))) start++;
    const end = fenceEnd(input, start);
    if (end >= 0) {
      input.acceptToken(FrontmatterFence, end);
      return;
    }
  }
  if (inFrontmatter) {
    // The script runs to the start of the closing fence's line, or to the end.
    for (let i = 0; ; i++) {
      const ch = input.peek(i);
      if (ch === -1) return input.acceptToken(FrontmatterScript, i);
      if (ch === NEWLINE && fenceEnd(input, i + 1) >= 0) return input.acceptToken(FrontmatterScript, i + 1);
    }
  }
  let length = 0;
  while (input.peek(length) !== -1) length++;
  input.acceptToken(Template, length);
});
