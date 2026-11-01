import { describe, expect, it } from "vitest";
import type { CodeAction } from "@/bindings";
import { isGenerateAction } from "./generate";

const action = (title: string, kind: string | null = null) => ({ title, kind }) as CodeAction;

describe("Generate action filter", () => {
  it.each([
    "Add test for Add",
    "Declare missing methods of I",
    "Add methods to T to implement an interface...",
    "Generate toString()",
    "Generate constructor",
    "Implement interface 'I'",
    "Override methods",
    "Add missing members",
    "Add derive",
    "Add impl",
    "Add getter",
    "Create constructor",
  ])("includes %s", (title) => expect(isGenerateAction(action(title))).toBe(true));

  it("accepts source.addTest independently of its title and advertised kinds", () => {
    expect(isGenerateAction(action("Localized test action", "source.addTest"))).toBe(true);
  });

  it.each([
    "Browse documentation for type T",
    "Extract declarations to new file",
    "Add import",
    "Add test framework",
    "Add methods to documentation",
    "Declare variable",
    "Split package",
  ])("excludes %s", (title) => expect(isGenerateAction(action(title))).toBe(false));
});
