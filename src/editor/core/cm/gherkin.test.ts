import { foldable } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { gherkinSupport } from "./gherkin";

const DOC = `@smoke
Feature: Checkout
  As a shopper

  Background:
    Given a cart

  Scenario Outline: pay with <method>
    When I pay with "<method>":
      | amount |
      | 10     |
    Then I see:
      """
      Thanks
      """

    Examples:
      | method |
      | card   |
`;

describe("Gherkin", () => {
  const state = EditorState.create({ doc: DOC, extensions: gherkinSupport() });
  const foldAt = (lineText: string) => {
    const line = state.doc.line(DOC.split("\n").findIndex((l) => l.trim() === lineText) + 1);
    const r = foldable(state, line.from, line.to);
    return r ? state.doc.lineAt(r.to).text.trim() : null;
  };

  it("folds sections, step arguments and doc strings by indentation", () => {
    expect(foldAt("Feature: Checkout")).toBe("| card   |");
    expect(foldAt("Background:")).toBe("Given a cart");
    expect(foldAt("Scenario Outline: pay with <method>")).toBe("| card   |");
    expect(foldAt('When I pay with "<method>":')).toBe("| 10     |");
    expect(foldAt('"""')).toBe('"""');
    expect(foldAt("Given a cart")).toBeNull();
    expect(foldAt("@smoke")).toBeNull();
  });
});
