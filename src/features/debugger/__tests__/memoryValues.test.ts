import { describe, expect, it } from "vitest";
import { formatJvmValue, objectRef, refKey } from "../memory/values";

describe("formatJvmValue", () => {
  it("formats values without calling toString", () => {
    expect(formatJvmValue({ kind: "object", id: 12, typeName: "com.x.Order" })).toBe("Order@12");
    expect(formatJvmValue({ kind: "array", id: 3, typeName: "java.lang.String[][]", length: 2 })).toBe("String[][2]");
    expect(formatJvmValue({ kind: "string", id: 4, text: 'a"b', length: 3 })).toBe('"a\\"b"');
    expect(formatJvmValue({ kind: "string", id: 5, text: null, length: 50000000 })).toBe("String (50,000,000 chars)");
    expect(formatJvmValue({ kind: "boxed", id: 6, typeName: "java.lang.Integer", text: "42" })).toBe("42");
  });

  it("shows null and primitives as their text", () => {
    expect(formatJvmValue({ kind: "null" })).toBe("null");
    expect(formatJvmValue({ kind: "primitive", typeName: "int", text: "7" })).toBe("7");
  });

  it("keeps the nested-class marker and names a default-package class as is", () => {
    expect(formatJvmValue({ kind: "object", id: 1, typeName: "com.x.Outer$Inner" })).toBe("Outer$Inner@1");
    expect(formatJvmValue({ kind: "object", id: 2, typeName: "Main" })).toBe("Main@2");
  });

  it("writes an array's length after its element type", () => {
    expect(formatJvmValue({ kind: "array", id: 3, typeName: "int[]", length: 3 })).toBe("int[3]");
    expect(formatJvmValue({ kind: "array", id: 3, typeName: "int[]", length: 0 })).toBe("int[0]");
  });
});

describe("objectRef", () => {
  it("pairs the generation with the id of a value that has one", () => {
    expect(objectRef(2, { kind: "object", id: 7, typeName: "a.B" })).toEqual({ generation: 2, id: 7 });
    expect(objectRef(2, { kind: "string", id: 8, text: "x", length: 1 })).toEqual({ generation: 2, id: 8 });
    expect(objectRef(2, { kind: "boxed", id: 9, typeName: "java.lang.Long", text: "1" })).toEqual({
      generation: 2,
      id: 9,
    });
    expect(objectRef(2, { kind: "array", id: 10, typeName: "int[]", length: 1 })).toEqual({ generation: 2, id: 10 });
  });

  it("has no reference for null and primitives", () => {
    expect(objectRef(2, { kind: "null" })).toBeNull();
    expect(objectRef(2, { kind: "primitive", typeName: "int", text: "1" })).toBeNull();
  });
});

describe("refKey", () => {
  it("joins generation and id", () => {
    expect(refKey({ generation: 2, id: 7 })).toBe("2:7");
  });
});
