import { describe, expect, it } from "vitest";
import { isFileHeaderFold } from "./document";

describe("isFileHeaderFold", () => {
  it("treats a comment block at the top of the file as the header", () => {
    // First code line is 3; header comment folds start at lines 1-2.
    expect(isFileHeaderFold(1, 3, "#!/usr/bin/env python", "#", null)).toBe(true);
    expect(isFileHeaderFold(2, 3, "# Copyright 2026", "#", null)).toBe(true);
    expect(isFileHeaderFold(1, 3, "   # license", "#", null)).toBe(true);
    expect(isFileHeaderFold(1, 3, "// license", "//", ["/*", "*/"])).toBe(true);
    expect(isFileHeaderFold(1, 2, "/* license */", "//", ["/*", "*/"])).toBe(true);
  });

  it("keeps documentation comments further down under documentation comments", () => {
    // The reviewer's regression: a doc comment above a function far down the
    // file starts with the line comment token but is NOT the file header.
    expect(isFileHeaderFold(20, 1, "// Returns the room", "//", ["/*", "*/"])).toBe(false);
    expect(isFileHeaderFold(8, 1, "# docs for f", "#", null)).toBe(false);
    expect(isFileHeaderFold(5, 1, "/** Javadoc */", "//", ["/*", "*/"])).toBe(false);
  });

  it("treats a Python docstring at the top of the file as documentation, not a header", () => {
    // Python: lineComment '#', no block comment; a docstring opens with quotes,
    // so even though it is line 1 it must not be classified as a file header.
    expect(isFileHeaderFold(1, 1, '"""Module docstring.', "#", null)).toBe(false);
    expect(isFileHeaderFold(1, 1, "'''Module docstring.", "#", null)).toBe(false);
  });

  it("does not classify ordinary code or a code-less file as a header", () => {
    expect(isFileHeaderFold(1, 2, "import os", "#", null)).toBe(false);
    // firstCodeLine === 0 means no real code line (only blanks / shebang).
    expect(isFileHeaderFold(1, 0, "# just a comment", "#", null)).toBe(false);
  });
});
