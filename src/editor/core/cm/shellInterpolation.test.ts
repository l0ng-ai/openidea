import { describe, expect, it } from "vitest";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { highlightTree, tags } from "@lezer/highlight";
import { shellInterpolation } from "./shellInterpolation";
import { openideaHighlightStyle } from "./highlight";

const language = StreamLanguage.define(shellInterpolation(shell));
function tokens(doc: string) {
  const result: { text: string; cls: string }[] = [];
  highlightTree(language.parser.parse(doc), openideaHighlightStyle, (from, to, cls) => {
    result.push({ text: doc.slice(from, to), cls });
  });
  return result;
}
const token = (text: string, tag: typeof tags.string) => ({ text, cls: openideaHighlightStyle.style([tag]) });

describe("shell interpolation", () => {
  it("separates variables, command substitutions and arithmetic inside strings", () => {
    const result = tokens('echo "$name ${count:-1} $(echo hi) $((count + 1))"');
    for (const text of ["$", "${", "}", "$(", ")", "$((", "))"]) {
      expect(result).toContainEqual(token(text, tags.special(tags.brace)));
    }
    for (const text of ["name", "count"]) expect(result).toContainEqual(token(text, tags.variableName));
    expect(result).toContainEqual(token("1", tags.number));
    expect(result).toContainEqual(token("+", tags.operator));
    expect(result).toContainEqual(token("echo", tags.standard(tags.variableName)));
  });

  it("highlights parameter operators without treating length expansion as a comment", () => {
    const result = tokens('echo "${#name} ${name:-1}"');
    expect(result).toContainEqual(token("#", tags.operator));
    expect(result).toContainEqual(token("name", tags.variableName));
    expect(result).toContainEqual(token(":-", tags.operator));
    expect(result.some((item) => item.cls === openideaHighlightStyle.style([tags.comment]))).toBe(false);
  });

  it("keeps nested command substitutions and quoted strings independent", () => {
    const result = tokens('echo "$(echo "$(echo hi)") after"');
    expect(result.filter((item) => item.text === "$(")).toHaveLength(2);
    expect(result.filter((item) => item.text === ")")).toHaveLength(2);
    expect(result).toContainEqual(token(' after"', tags.string));
  });

  it("leaves single quotes, escaped dollars, comments and heredocs intact", () => {
    for (const doc of ["echo '$name ${count}'", 'echo "\\$name"', '# "${count}"', "cat <<'EOF'\n$name ${count}\nEOF"]) {
      expect(tokens(doc).some((item) => item.cls === openideaHighlightStyle.style([tags.special(tags.brace)]))).toBe(
        false,
      );
    }
  });
});
