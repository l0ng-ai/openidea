import { describe, expect, it } from "vitest";
import { parseComparison } from "./comparison";

describe("parseComparison", () => {
  it("JUnit / opentest4j", () => {
    expect(parseComparison(["org.opentest4j.AssertionFailedError: expected: <3> but was: <4>"])).toEqual({
      expected: "3",
      actual: "4",
    });
    expect(parseComparison(['expected: "a b"', ' but was: "a c"'])).toEqual({ expected: '"a b"', actual: '"a c"' });
  });

  it("TestNG", () => {
    expect(parseComparison(["java.lang.AssertionError: total expected [3] but found [2]"])).toEqual({
      expected: "3",
      actual: "2",
    });
  });

  it("kotlin.test", () => {
    expect(parseComparison(["java.lang.AssertionError: Expected <1>, actual <2>."])).toEqual({
      expected: "1",
      actual: "2",
    });
  });

  it("jest / vitest", () => {
    expect(
      parseComparison([
        "    expect(received).toBe(expected) // Object.is equality",
        "",
        "    Expected: 3",
        "    Received: 4",
      ]),
    ).toEqual({ expected: "3", actual: "4" });
  });

  it("rust assert_eq! keeps left / right", () => {
    expect(parseComparison(["assertion `left == right` failed", "  left: 3", " right: 4"])).toEqual({
      expected: "3",
      actual: "4",
      labels: { expected: "Left", actual: "Right" },
    });
  });

  it("go testify and pytest", () => {
    expect(
      parseComparison(["\tError:      \tNot equal: ", "\t            \texpected: 3", "\t            \tactual  : 4"]),
    ).toEqual({
      expected: "3",
      actual: "4",
    });
    expect(parseComparison([">       assert add(1, 2) == 4", "E       assert 3 == 4"])).toEqual({
      expected: "4",
      actual: "3",
    });
  });

  it("no comparison in other failures", () => {
    expect(parseComparison(["java.lang.IllegalStateException: boom", "\tat com.acme.A.b(A.java:3)"])).toBeNull();
  });
});
