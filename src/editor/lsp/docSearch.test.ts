import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateDocMatch,
  clearDocSearch,
  DOC_SEARCH_CURRENT,
  DOC_SEARCH_MATCH,
  highlightDocSearch,
} from "./docSearch";

afterEach(() => document.body.replaceChildren());

describe("documentation DOM search", () => {
  it("finds case-insensitive literal matches without changing the rendered markup", () => {
    const root = document.body.appendChild(document.createElement("div"));
    const strong = document.createElement("strong");
    strong.textContent = "BETA";
    root.replaceChildren("Alpha ", strong, " tail beta.");
    const hidden = document.createElement("span");
    hidden.setAttribute("aria-hidden", "true");
    hidden.textContent = "beta";
    root.appendChild(hidden);
    const before = root.textContent;

    const matches = highlightDocSearch(root, "beta");
    expect(matches.map((match) => match.map((mark) => mark.textContent))).toEqual([["BETA"], ["beta"]]);
    expect(root.textContent).toBe(before);
    expect(root.querySelector("strong")).toBe(strong);
    expect(root.querySelectorAll(`[${DOC_SEARCH_MATCH}]`)).toHaveLength(2);

    clearDocSearch(root);
    expect(root.querySelectorAll("mark")).toHaveLength(0);
    expect(root.querySelector("strong")).toBe(strong);
    expect(root.textContent).toBe(before);
  });

  it("keeps a match across inline nodes together and activates all of its fragments", () => {
    const root = document.body.appendChild(document.createElement("div"));
    const strong = document.createElement("strong");
    strong.textContent = "two";
    const code = document.createElement("code");
    code.textContent = "three";
    root.replaceChildren("one ", strong, " ", code, " and ", strong.cloneNode(true), " ", code.cloneNode(true));

    const matches = highlightDocSearch(root, "two three");
    expect(matches).toHaveLength(2);
    expect(matches.every((match) => match.length === 3)).toBe(true);
    const scroll = vi.fn();
    matches[1]![0]!.scrollIntoView = scroll;

    activateDocMatch(matches, 1);
    expect(matches[0]!.every((mark) => !mark.hasAttribute(DOC_SEARCH_CURRENT))).toBe(true);
    expect(matches[1]!.every((mark) => mark.hasAttribute(DOC_SEARCH_CURRENT))).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
    expect(root.textContent).toBe("one two three and two three");
  });

  it("can mark the active match without scrolling after a DOM update", () => {
    const root = document.body.appendChild(document.createElement("div"));
    root.textContent = "beta beta";
    const matches = highlightDocSearch(root, "beta");
    const scroll = vi.fn();
    matches[1]![0]!.scrollIntoView = scroll;

    activateDocMatch(matches, 1, { scroll: false });
    expect(matches[0]!.every((mark) => !mark.hasAttribute(DOC_SEARCH_CURRENT))).toBe(true);
    expect(matches[1]!.every((mark) => mark.hasAttribute(DOC_SEARCH_CURRENT))).toBe(true);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("escapes regex syntax and never parses matched text as HTML", () => {
    const root = document.body.appendChild(document.createElement("div"));
    root.textContent = "a.b [x] a.b <img src=x onerror=alert(1)>";

    expect(highlightDocSearch(root, "a.b")).toHaveLength(2);
    const matches = highlightDocSearch(root, "<img src=x onerror=alert(1)>");
    expect(matches).toHaveLength(1);
    expect(matches[0]![0]!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(matches[0]![0]!.children).toHaveLength(0);
    expect(root.querySelector("img")).toBeNull();
  });

  it("clears previous highlights for an empty query", () => {
    const root = document.body.appendChild(document.createElement("div"));
    root.textContent = "alpha alpha";
    highlightDocSearch(root, "alpha");
    expect(root.querySelectorAll("mark")).toHaveLength(2);
    expect(highlightDocSearch(root, "")).toEqual([]);
    expect(root.querySelectorAll("mark")).toHaveLength(0);
    expect(root.textContent).toBe("alpha alpha");
  });
});
