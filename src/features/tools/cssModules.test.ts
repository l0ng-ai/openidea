import { describe, expect, it } from "vitest";
import { cmkOptionsInsertion, cmkState, stripJsonc, usesCssModules } from "./cssModules";

const insert = (text: string) => {
  const edit = cmkOptionsInsertion(text)!;
  return text.slice(0, edit.at) + edit.text + text.slice(edit.at);
};

describe("CSS Modules Kit hint", () => {
  it("reads cmkOptions from tsconfig.json with comments and trailing commas", () => {
    const tsconfig =
      '{\n  // "cmkOptions": { "enabled": true },\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },\n}\n';
    expect(JSON.parse(stripJsonc(tsconfig))).toEqual({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });
    expect(cmkState(tsconfig)).toBe("absent");
    expect(cmkState('{ /* on */ "cmkOptions": { "enabled": true } }')).toBe("enabled");
    expect(cmkState('{ "cmkOptions": { "enabled": false } }')).toBe("set");
    expect(cmkState('{ "a": "// not a comment, }" }')).toBe("absent");
    expect(cmkState("{ broken")).toBeNull();
  });

  it("adds the option as the first property, keeping the file's comments and indentation", () => {
    const tsconfig = '// app\n{\n    // strict\n    "compilerOptions": { "strict": true }\n}\n';
    const edited = insert(tsconfig);
    expect(edited).toBe(
      '// app\n{\n    "cmkOptions": { "enabled": true },\n    // strict\n    "compilerOptions": { "strict": true }\n}\n',
    );
    expect(cmkState(edited)).toBe("enabled");
    expect(insert("{}")).toBe('{\n  "cmkOptions": { "enabled": true }\n}');
    expect(cmkState(insert("{ /* empty */ }"))).toBe("enabled");
    expect(cmkOptionsInsertion("[]")).toBeNull();
  });

  it("looks for CSS Modules in stylesheets and the scripts that import them", () => {
    expect(usesCssModules("/p/src/Button.module.css", null)).toBe(true);
    expect(usesCssModules("/p/src/app.css", null)).toBe(false);
    expect(usesCssModules("/p/src/Button.tsx", "import s from './Button.module.css';")).toBe(true);
    expect(usesCssModules("/p/src/Button.tsx", "import './app.css';")).toBe(false);
    expect(usesCssModules("/p/README.md", "Button.module.css")).toBe(false);
  });
});
