import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const executeAction = vi.hoisted(() => vi.fn());
vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction,
}));

import { useProject } from "@/platform/project";
import { djangoTemplateBanner, isDjangoContent, noteDjangoContent, useDjangoContent } from "./djangoTemplates";

afterEach(() => {
  useDjangoContent.setState({ detected: {} });
  useProject.setState({ project: null, settings: null });
  executeAction.mockClear();
});

describe("Django template detection", () => {
  it("recognizes Django's own tags, not other braces", () => {
    expect(isDjangoContent(`<html>{% load static %}<img src="{% static 'a.png' %}"></html>`)).toBe(true);
    expect(isDjangoContent("{% extends 'base.html' %}")).toBe(true);
    expect(isDjangoContent("<p>{% csrf_token %}</p>")).toBe(true);
    expect(isDjangoContent("<p>{{ value }}</p>")).toBe(false);
    expect(isDjangoContent("<p>100% {% of %}</p>")).toBe(false);
    expect(isDjangoContent("<p>{% if\nbroken %}</p>")).toBe(false);
  });

  it("offers Django Template for a detected HTML file until it has a file type override", () => {
    const path = "/p/site/page.html";
    const banner = () => renderHook(() => djangoTemplateBanner.useBanner(path)).result.current;
    expect(banner()).toBeNull();
    noteDjangoContent(path, "{% block content %}{% endblock %}");
    const shown = banner();
    expect(shown?.text).toBe("This file has Django template tags");
    shown!.actions![1]!.run();
    expect(executeAction).toHaveBeenCalledWith("file.overrideFileType", { path, language: "django-html" });
    shown!.actions![0]!.run();
    expect(executeAction).toHaveBeenCalledWith("file.overrideFileType", { path, language: "html" });
    useProject.setState({
      project: { root: "/p" } as never,
      settings: { files: { fileTypeOverrides: { "site/page.html": "html" } } } as never,
    });
    expect(banner()).toBeNull();
    noteDjangoContent("/p/other.html", "<p>plain</p>");
    expect(useDjangoContent.getState().detected).toEqual({ [path]: true });
  });
});
