import { describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ mavenGotoDeclaration: vi.fn() }));
const workbench = vi.hoisted(() => ({ openFile: vi.fn() }));
const hints = vi.hoisted(() => ({ showHint: vi.fn() }));

vi.mock("@/platform/ipc", () => ({
  call: async (p: Promise<{ status: string; data?: unknown; error?: unknown }>) => {
    const r = await p;
    if (r.status !== "ok") throw r.error;
    return r.data;
  },
  commands: ipc,
}));
vi.mock("@/workbench/contributions", () => ({
  editorService: () => workbench,
}));
vi.mock("@/editor/lsp/hint", () => ({ showHint: hints.showHint }));
vi.mock("@/editor/api", () => ({
  CONTRIBUTED_DEFINITION: "openideaDefinition",
  whenSynced: () => Promise.resolve(),
}));

import { EditorState } from "@codemirror/state";
import { inArtifactElement, pomNavigationExtension, propertyRefAt } from "./pomNavigation";

const DEFINITION = "openideaDefinition";

/** An editor state over `text` with the contribution for `path` installed. */
function state(text: string, path = "/p/app/pom.xml") {
  return EditorState.create({
    doc: text,
    extensions: [
      pomNavigationExtension({
        path,
        language: "xml",
        uiMode: "XML",
        readOnly: false,
      } as Parameters<typeof pomNavigationExtension>[0]),
    ],
  });
}

const definitionAt = (s: ReturnType<typeof state>, pos: number) =>
  s.languageDataAt<(v: { state: typeof s }, p: number) => boolean>(DEFINITION, pos)[0];

/** The definition only reads `view.state`; a bare handle is enough. */
const run = (s: ReturnType<typeof state>, pos: number) => definitionAt(s, pos)!({ state: s }, pos);

const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <parent>
    <groupId>com.example</groupId>
    <artifactId>parent</artifactId>
    <version>1.0</version>
  </parent>
  <artifactId>app</artifactId>
  <properties>
    <example.version>1.2.3</example.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>example-lib</artifactId>
      <version>\${example.version}</version>
    </dependency>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>other-lib</artifactId>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>`;

describe("POM property references", () => {
  it("finds the reference spanning the caret, the $ and the } included", () => {
    const at = pom.indexOf("${example.version}");
    expect(propertyRefAt(pom, at)).toEqual({
      from: at,
      to: at + "${example.version}".length,
    });
    expect(propertyRefAt(pom, at + 1)).toEqual({
      from: at,
      to: at + "${example.version}".length,
    });
    expect(propertyRefAt(pom, at + "${example.version}".length - 1)).toEqual({
      from: at,
      to: at + "${example.version}".length,
    });
    // Outside a reference: none.
    expect(propertyRefAt(pom, pom.indexOf("example-lib"))).toBeNull();
    // A reference closed before the caret does not reach over it.
    const afterRef = at + "${example.version}".length + 1;
    expect(propertyRefAt(pom, afterRef)).toBeNull();
  });
});

describe("POM artifact elements", () => {
  it("sees a dependency or plugin element around the caret", () => {
    expect(inArtifactElement(pom, pom.indexOf("<artifactId>example-lib"))).toBe(true);
    expect(inArtifactElement(pom, pom.indexOf("example-lib</artifactId>"))).toBe(true);
    expect(inArtifactElement(pom, pom.indexOf("<artifactId>maven-compiler-plugin"))).toBe(true);
    expect(inArtifactElement(pom, pom.indexOf("${example.version}"))).toBe(true);
    // Inside `<parent>`: its artifact is the parent POM.
    expect(inArtifactElement(pom, pom.indexOf("<parent>") + "<parent>".length + 1)).toBe(true);
  });

  it("sees no artifact element outside dependencies, plugins and the parent", () => {
    expect(inArtifactElement(pom, pom.indexOf("<properties>"))).toBe(false);
    expect(inArtifactElement(pom, pom.indexOf("<parent>"))).toBe(false);
    // `<plugins>` and `<dependencyManagement>` are not a `<plugin>` / `<dependency>`.
    expect(inArtifactElement(pom, pom.indexOf("<plugins>"))).toBe(false);
  });
});

describe("POM go to declaration", () => {
  it("contributes a definition on a property reference and an artifact element only", () => {
    const s = state(pom);
    expect(definitionAt(s, pom.indexOf("${example.version}"))).toBeDefined();
    expect(definitionAt(s, pom.indexOf("<artifactId>other-lib"))).toBeDefined();
    expect(definitionAt(s, pom.indexOf("<artifactId>maven-compiler-plugin"))).toBeDefined();
    expect(definitionAt(s, pom.indexOf("<properties>"))).toBeUndefined();
    expect(definitionAt(s, pom.indexOf("<parent>"))).toBeUndefined();
  });

  it("opens the declaration the backend resolved", async () => {
    const target = {
      path: "/p/pom.xml",
      range: { start: { line: 4, col: 6 }, end: { line: 4, col: 14 } },
      kind: "property",
      label: "example.version",
    };
    ipc.mavenGotoDeclaration.mockResolvedValue({ status: "ok", data: target });
    const s = state(pom);
    const at = pom.indexOf("${example.version}");
    run(s, at);
    await vi.waitFor(() =>
      expect(workbench.openFile).toHaveBeenCalledWith("/p/pom.xml", {
        selection: { line: 4, col: 6, endLine: 4, endCol: 14 },
      }),
    );
    expect(ipc.mavenGotoDeclaration).toHaveBeenCalledWith("/p/app/pom.xml", {
      line: pom.slice(0, at).split("\n").length - 1,
      col: at - (pom.lastIndexOf("\n", at - 1) + 1),
    });
  });

  it("says so when nothing resolves, without navigating", async () => {
    ipc.mavenGotoDeclaration.mockResolvedValue({ status: "ok", data: null });
    const s = state(pom);
    const at = pom.indexOf("<artifactId>other-lib");
    run(s, at);
    await vi.waitFor(() => expect(hints.showHint).toHaveBeenCalled());
    expect(workbench.openFile).not.toHaveBeenCalled();
  });

  it("contributes nothing outside a pom.xml", () => {
    const s = state(pom, "/p/app/build.xml");
    expect(definitionAt(s, pom.indexOf("${example.version}"))).toBeUndefined();
    expect(ipc.mavenGotoDeclaration).not.toHaveBeenCalled();
  });
});
