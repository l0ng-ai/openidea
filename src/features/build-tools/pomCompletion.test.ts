import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";

const mavenDependencyCompletion = vi.fn();
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, mavenDependencyCompletion },
  };
});

const { pomCompletionExtension } = await import("./pomCompletion");

const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>exa</artifactId>
      <version>1.0</version>
    </dependency>
  </dependencies>
</project>`;
const artifactId = pom.indexOf("exa");

/** An editor over `text` with the contribution for a pom.xml installed. */
function editor(path = "/p/app/pom.xml", readOnly = false, source = pom) {
  const ctx = { doc: 7, path, language: "xml", uiMode: "XML", readOnly };
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: source,
      selection: { anchor: artifactId + 3 },
      extensions: [pomCompletionExtension(ctx)],
    }),
  });
  views.push(view);
  return view;
}

const views: EditorView[] = [];

beforeEach(() => {
  mavenDependencyCompletion.mockReset();
});
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
});

describe("POM dependency completion", () => {
  it("asks the backend at the caret and offers its coordinates for the whole value", async () => {
    const view = editor();
    const source = view.state.languageDataAt<(ctx: CompletionContext) => Promise<unknown>>(
      "openideaCompletion",
      artifactId + 3,
    )[0]!;
    mavenDependencyCompletion.mockResolvedValue({
      status: "ok",
      data: {
        from: artifactId,
        to: artifactId + 3,
        kind: "artifactId",
        options: [
          { label: "example-lib", detail: "2.0" },
          { label: "example-api", detail: null },
        ],
      },
    });
    const result = (await source(new CompletionContext(view.state, artifactId + 3, true, view))) as {
      from: number;
      to: number;
      filter: boolean;
      options: { label: string; type: string; detail?: string; apply: string; boost: number }[];
    };
    expect(result).toMatchObject({ from: artifactId, to: artifactId + 3, filter: false });
    expect(result.options).toEqual([
      { label: "example-lib", type: "constant", detail: "2.0", apply: "example-lib", boost: 99 },
      { label: "example-api", type: "constant", detail: undefined, apply: "example-api", boost: 98 },
    ]);
    expect(mavenDependencyCompletion).toHaveBeenCalledWith(7, artifactId + 3, expect.any(Number));
  });

  it("offers nothing outside a pom.xml or a read-only one", async () => {
    const other = editor("/p/app/build.xml");
    expect(other.state.languageDataAt("openideaCompletion", artifactId + 3)).toEqual([]);
    const readonly = editor("/p/app/pom.xml", true);
    expect(readonly.state.languageDataAt("openideaCompletion", artifactId + 3)).toEqual([]);
    expect(mavenDependencyCompletion).not.toHaveBeenCalled();
  });

  it("stays silent when the caret moved on, the document changed or the backend failed", async () => {
    const view = editor();
    const source = view.state.languageDataAt<(ctx: CompletionContext) => Promise<unknown>>(
      "openideaCompletion",
      artifactId + 3,
    )[0]!;
    // A stale reply (the user kept typing while the backend answered).
    let resolve!: (value: unknown) => void;
    mavenDependencyCompletion.mockImplementation(() => new Promise((r) => (resolve = r)));
    const pending = source(new CompletionContext(view.state, artifactId + 3, true, view));
    await vi.waitFor(() => expect(mavenDependencyCompletion).toHaveBeenCalled());
    view.dispatch({ changes: { from: artifactId, to: artifactId + 3, insert: "example-lib" } });
    resolve({
      status: "ok",
      data: {
        from: artifactId,
        to: artifactId + 3,
        kind: "artifactId",
        options: [{ label: "example-lib", detail: null }],
      },
    });
    expect(await pending).toBeNull();
    // A failure of the remote lookup never surfaces as an error.
    mavenDependencyCompletion.mockRejectedValue(new Error("offline"));
    expect(await source(new CompletionContext(view.state, artifactId + 3, true, view))).toBeNull();
    // No suggestions: no lookup.
    mavenDependencyCompletion.mockResolvedValue({
      status: "ok",
      data: { from: artifactId, to: artifactId, kind: "artifactId", options: [] },
    });
    expect(await source(new CompletionContext(view.state, artifactId + 3, true, view))).toBeNull();
  });
});
