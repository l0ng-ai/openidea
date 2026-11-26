import { describe, expect, it } from "vitest";
import { cycleIdentifierCase, identifierCase, identifierWords, wordSpan } from "./identifierCase";

describe("identifier case", () => {
  it("reads the style an identifier is written in", () => {
    expect(identifierCase("my_var_name")).toBe("snake");
    expect(identifierCase("MY_VAR_NAME")).toBe("screaming");
    expect(identifierCase("my-var-name")).toBe("kebab");
    expect(identifierCase("myVarName")).toBe("camel");
    expect(identifierCase("MyVarName")).toBe("pascal");
    expect(identifierCase("user name")).toBe("kebab");
    expect(identifierCase("FOO_1")).toBe("screaming");
  });

  it("splits a name into words at separators, case changes and the end of an acronym", () => {
    expect(identifierWords("myHTTPServer2_v2")).toEqual(["my", "HTTP", "Server2", "v2"]);
    expect(identifierWords("user  name.is_mine-here")).toEqual(["user", "name", "is", "mine", "here"]);
    expect(identifierWords("--")).toEqual([]);
  });

  it("spans a selection from its first to its last word character", () => {
    expect(wordSpan("  user name \n")).toEqual({ from: 2, to: 11 });
    expect(wordSpan(" -- ")).toBeNull();
  });

  it("has no style without a cased letter", () => {
    expect(identifierCase("2024")).toBeNull();
    expect(identifierCase("")).toBeNull();
    expect(identifierCase("变量")).toBeNull();
  });
});

describe("cycle identifier case", () => {
  it("goes snake_case → SCREAMING_SNAKE_CASE → kebab-case → camelCase → PascalCase", () => {
    expect(cycleIdentifierCase("my_var_name")).toBe("MY_VAR_NAME");
    expect(cycleIdentifierCase("MY_VAR_NAME")).toBe("my-var-name");
    expect(cycleIdentifierCase("my-var-name")).toBe("myVarName");
    expect(cycleIdentifierCase("myVarName")).toBe("MyVarName");
    expect(cycleIdentifierCase("MyVarName")).toBe("my_var_name");
  });

  it("gives one word its three spellings: name → Name → NAME", () => {
    expect(cycleIdentifierCase("name")).toBe("Name");
    expect(cycleIdentifierCase("Name")).toBe("NAME");
    expect(cycleIdentifierCase("NAME")).toBe("name");
  });

  it("skips a style that writes the name the same way", () => {
    // A word that starts with a digit looks the same in camelCase and PascalCase.
    expect(cycleIdentifierCase("2nd place")).toBe("2ndPlace");
    expect(cycleIdentifierCase("2ndPlace")).toBe("2nd_place");
  });

  it("reads a selected phrase as words and converts it", () => {
    expect(cycleIdentifierCase("user name")).toBe("userName");
    expect(cycleIdentifierCase("user.name")).toBe("userName");
    expect(cycleIdentifierCase("User  Name")).toBe("userName");
  });

  it("splits acronyms and keeps digits with their word", () => {
    expect(cycleIdentifierCase("parseHTTPResponse")).toBe("ParseHTTPResponse");
    expect(cycleIdentifierCase("ParseHTTPResponse")).toBe("parse_http_response");
    expect(cycleIdentifierCase("v2Api")).toBe("V2Api");
    expect(cycleIdentifierCase("XMLHttpRequest")).toBe("xml_http_request");
  });

  it("follows the lower and upper case of letters, not of the whole string", () => {
    expect(cycleIdentifierCase("a_b")).toBe("A_B");
    expect(cycleIdentifierCase("a-b")).toBe("aB");
    expect(cycleIdentifierCase("ab")).toBe("Ab");
    expect(cycleIdentifierCase("grüße")).toBe("Grüße");
    expect(cycleIdentifierCase("Grüße")).toBe("GRÜSSE");
  });

  it("leaves text without a cased letter alone", () => {
    expect(cycleIdentifierCase("2024")).toBeNull();
    expect(cycleIdentifierCase("")).toBeNull();
    expect(cycleIdentifierCase("变量")).toBeNull();
  });
});
