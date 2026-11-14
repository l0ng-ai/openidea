import { describe, expect, it } from "vitest";
import { appendIgnoreRevision } from "../blameIgnore";

const first = "a".repeat(40);
const second = "b".repeat(40);

describe("annotate ignore list", () => {
  it("starts the list when there is no file yet", () => {
    expect(appendIgnoreRevision("", second)).toBe(`${second}\n`);
  });

  it("keeps the existing lines and appends the commit", () => {
    expect(appendIgnoreRevision(`${first}\n# comment\n`, second)).toBe(`${first}\n# comment\n${second}\n`);
  });

  it("ends the file with a newline", () => {
    expect(appendIgnoreRevision(first, second)).toBe(`${first}\n${second}\n`);
  });

  it("does not repeat a commit that is already listed", () => {
    const listed = `# reformat\n${second}\n${first}\n`;
    expect(appendIgnoreRevision(listed, second)).toBe(listed);
    expect(appendIgnoreRevision(`  ${second}  \n`, second)).toBe(`  ${second}  \n`);
  });

  it("keeps CRLF line endings", () => {
    expect(appendIgnoreRevision(`${first}\r\n`, second)).toBe(`${first}\r\n${second}\r\n`);
  });
});
