import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { call } from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useMarkdownModes } from "../markdown/modes";
import { activate as activateViewers } from "../index";
import { useLiveRst } from "./live";
import { RstEditor } from "./RstEditor";
import { rstModes } from "./RstLayoutActions";

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: vi.fn(),
    commands: { ...real.commands, rstPreview: (path: string, text: string) => ({ rstPreview: [path, text] }) },
  };
});
vi.mock("@/platform/openUrl", () => ({ openExternalUrl: vi.fn(async () => {}) }));

const PATH = "/p/docs/index.rst";
// Hidden while an error shows, so found by label rather than role.
const preview = () => document.querySelector<HTMLElement>('[aria-label="reStructuredText preview"]')!;

/** docutils answers `html` for any text, or fails with `error`. */
function docutils(answer: { html: string } | { error: string }) {
  vi.mocked(call).mockImplementation(async (request: unknown) => {
    if (!(request as { rstPreview?: unknown }).rstPreview) throw new Error("unexpected call");
    if ("error" in answer) throw new Error(answer.error);
    return answer.html;
  });
}

async function show() {
  render(
    <RstEditor path={PATH} tabId="t">
      <div data-testid="source" />
    </RstEditor>,
  );
  await act(async () => {});
}

describe("reStructuredText editor", () => {
  beforeEach(() => {
    localStorage.clear();
    rstModes.useModes.setState({ byTab: {}, fallback: "split" });
    useMarkdownModes.setState({ byTab: {}, fallback: "split" });
    useLiveRst.setState({ [PATH]: "Title\n=====\n" });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(call).mockReset();
  });

  it("shows docutils' HTML beside the source, sanitized and with nothing loaded from other hosts", async () => {
    docutils({
      html:
        '<main id="title"><h1 class="title">Title</h1><p onclick="x()">Hi<script>x()</script></p>' +
        '<img alt="remote" src="https://example.com/x.png" /><a href="#title">top</a>' +
        '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>e</mi></math></main>',
    });
    await show();
    expect(call).toHaveBeenCalledWith({ rstPreview: [PATH, "Title\n=====\n"] });
    expect(screen.getByTestId("source")).toBeInTheDocument();
    const root = preview();
    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("[onclick]")).toBeNull();
    expect(root.querySelector("math mi")?.textContent).toBe("e");
    // The preview shares the IDE's document: its ids can't clash with the IDE's own.
    expect(root.querySelector("main")?.id).toBe("user-content-title");
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")).toBeNull();
    expect(img.title).toBe("Remote images are not loaded");

    const scrolled = vi.fn();
    root.querySelector("main")!.scrollIntoView = scrolled;
    fireEvent.click(screen.getByText("top"));
    expect(scrolled).toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens external links in the browser, only on a click", async () => {
    docutils({ html: '<p><a class="reference external" href="https://example.com/">site</a></p>' });
    await show();
    expect(openExternalUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("site"));
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/");
  });

  it("says why there is no preview, and renders again as the source is typed", async () => {
    docutils({ error: "docutils is not installed for /p/.venv/bin/python." });
    await show();
    expect(screen.getByText("docutils is not installed for /p/.venv/bin/python.")).toBeInTheDocument();
    expect(preview()).not.toBeVisible();

    docutils({ html: "<p>fixed</p>" });
    await act(async () => useLiveRst.setState({ [PATH]: "fixed\n" }));
    expect(screen.queryByText(/docutils is not installed/)).toBeNull();
    expect(preview()).toBeVisible();
    expect(preview().textContent).toBe("fixed");
  });

  it("keeps its layout apart from Markdown's, set by the shared layout actions", async () => {
    docutils({ html: "<p>x</p>" });
    const off = activateViewers();
    setContext("textEditorActive", true);
    try {
      await show();
      await act(() => executeAction("markdown.previewOnly", "t"));
      expect(rstModes.useModes.getState().byTab["t"]).toBe("preview");
      expect(useMarkdownModes.getState().byTab["t"]).toBeUndefined();
      expect(localStorage.getItem("openidea.rst.defaultMode")).toBe("preview");
    } finally {
      setContext("textEditorActive", false);
      off();
    }
  });
});
