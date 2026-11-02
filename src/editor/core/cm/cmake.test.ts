import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";

const highlighter = tagHighlighter([
  { tag: t.standard(t.function(t.variableName)), class: "command" },
  { tag: t.function(t.definition(t.variableName)), class: "definition" },
  { tag: t.function(t.variableName), class: "call" },
  { tag: t.standard(t.variableName), class: "builtinVariable" },
  { tag: t.special(t.variableName), class: "expansion" },
  { tag: t.keyword, class: "keyword" },
  { tag: t.bool, class: "bool" },
  { tag: t.number, class: "number" },
  { tag: t.string, class: "string" },
  { tag: t.escape, class: "escape" },
  { tag: t.comment, class: "comment" },
]);

async function state(source: string) {
  const support = await loadSupport(findLanguageDescription("CMake", "CMakeLists.txt")!);
  return EditorState.create({ doc: source, extensions: [support!] });
}

function tokens(state: EditorState) {
  ensureSyntaxTree(state, state.doc.length, 1000);
  const out: { text: string; style: string }[] = [];
  highlightTree(syntaxTree(state), highlighter, (from, to, style) =>
    out.push({ text: state.doc.sliceString(from, to), style }),
  );
  return out;
}

describe("CMake highlighting", () => {
  it("styles the screenshot's commands, argument keywords and built-in variables", async () => {
    const out = tokens(
      await state(`cmake_minimum_required(VERSION 3.20)
project(OpenIdeaSmoke LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
add_executable(cpp_smoke main.cpp math.cpp)
enable_testing()
add_test(NAME cpp_result COMMAND cpp_smoke)
`),
    );
    for (const text of ["cmake_minimum_required", "project", "set", "add_executable", "enable_testing", "add_test"])
      expect(out).toContainEqual({ text, style: "command" });
    for (const text of ["VERSION", "LANGUAGES", "NAME", "COMMAND"])
      expect(out).toContainEqual({ text, style: "keyword" });
    for (const text of ["CMAKE_CXX_STANDARD", "CMAKE_EXPORT_COMPILE_COMMANDS"])
      expect(out).toContainEqual({ text, style: "builtinVariable" });
    expect(out).toContainEqual({ text: "3.20", style: "number" });
    expect(out).toContainEqual({ text: "17", style: "number" });
    expect(out).toContainEqual({ text: "ON", style: "bool" });
  });

  it("styles version ranges and the project, CTest and CPack predefined variables", async () => {
    const out = tokens(
      await state(
        "find_package(Qt6 6.2...<7.0 REQUIRED)\nmessage(${PROJECT_NAME} ${CTEST_SOURCE_DIRECTORY} ${CPACK_GENERATOR})\nset(PROJECT_VERSION 1.2.3)",
      ),
    );
    expect(out).toContainEqual({ text: "6.2...<7.0", style: "number" });
    expect(out).toContainEqual({ text: "1.2.3", style: "number" });
    expect(out).toContainEqual({ text: "PROJECT_VERSION", style: "builtinVariable" });
  });

  it("recognizes case-insensitive commands, control flow and user-defined functions", async () => {
    const out = tokens(
      await state(
        "FUNCTION(Build target)\n  MESSAGE(STATUS hello)\nENDFUNCTION()\nBuild(app)\nif(DEFINED CMAKE_BUILD_TYPE AND NOT OFF)\nendif()",
      ),
    );
    for (const text of ["FUNCTION", "ENDFUNCTION", "if", "DEFINED", "AND", "NOT", "endif"])
      expect(out).toContainEqual({ text, style: "keyword" });
    expect(out).toContainEqual({ text: "MESSAGE", style: "command" });
    expect(out).toContainEqual({ text: "Build", style: "definition" });
    expect(out).toContainEqual({ text: "Build", style: "call" });
  });

  it("separates quoted text, nested variable expansions, environment/cache lookups and escapes", async () => {
    const out = tokens(await state('message("hello ${${PREFIX}_NAME} $ENV{HOME} $CACHE{SDK} \\"quote\\" # text")'));
    for (const text of ["${${PREFIX}_NAME}", "$ENV{HOME}", "$CACHE{SDK}"])
      expect(out).toContainEqual({ text, style: "expansion" });
    expect(out).toContainEqual({ text: '\\"', style: "escape" });
    expect(out.some((t) => t.style === "comment")).toBe(false);
    expect(out.some((t) => t.style === "string" && t.text.includes("# text"))).toBe(true);
  });

  it("keeps multiline bracket comments and literal bracket strings opaque", async () => {
    const out = tokens(
      await state(
        "#[=[\nset(CMAKE_FAKE ON)\n]=]\nset(TEXT [==[\n${LITERAL} # raw\n]==])\n# line comment\nmessage(hello)",
      ),
    );
    expect(out.some((t) => t.style === "command" && t.text === "set")).toBe(true);
    expect(out.some((t) => t.text.includes("CMAKE_FAKE") && t.style === "comment")).toBe(true);
    expect(out.some((t) => t.text.includes("${LITERAL}") && t.style === "string")).toBe(true);
    expect(out.some((t) => t.style === "expansion")).toBe(false);
    expect(out).toContainEqual({ text: "message", style: "command" });
  });

  it("handles nested generator expressions without swallowing following commands", async () => {
    const expression = "$<IF:$<BOOL:${ENABLE}>,a,b>";
    const out = tokens(await state(`target_link_libraries(app PRIVATE ${expression})\nmessage(done)`));
    expect(out).toContainEqual({ text: expression, style: "expansion" });
    expect(out).toContainEqual({ text: "message", style: "command" });
  });

  it("reparses multiline string edits and resolves CMake filename associations", async () => {
    const before = await state("set(TEXT [=[\nmessage(hidden)\n]=])\nmessage(visible)");
    const out = tokens(before);
    expect(out.filter((t) => t.style === "command" && t.text === "message")).toHaveLength(1);
    const after = before.update({ changes: { from: 9, to: 12, insert: '"' } }).state;
    expect(tokens(after).filter((t) => t.style === "command" && t.text === "message")).toHaveLength(0);
    expect(tokens(before)).toEqual(out);
    for (const path of ["CMakeLists.txt", "module.cmake", "toolchain.cmake.in"])
      expect(findLanguageDescription(null, path)?.name, path).toBe("CMake");
  });
});
