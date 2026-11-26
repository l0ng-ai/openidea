import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, type DocumentInfo } from "@/platform/ipc";
import { copiedJavaType, renameCopiedJavaType, renameJavaTypeEdits } from "./javaCopy";

const SOURCE = `package a;

/** Foo, the original. */
public class Foo extends Base<Foo> {
  static final Foo INSTANCE = new Foo();
  private Foo() { this(1); }
  Foo(int x) {}
  static Foo of() { return Foo.INSTANCE; }
  Object me() { return Foo.this; }
  String s = "Foo"; // Foo
  List<Foo> all = Foo.list(Foo::of);
  void Foo() {}
}
class Helper { Foo f; }
`;

function apply(text: string, edits: { from: number; to: number; insert: string }[]): string {
  return [...edits].reverse().reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
}

describe("copying a Java source (#5647)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renames the type, its constructors and references, not strings, comments or a same-named method", () => {
    const out = apply(SOURCE, renameJavaTypeEdits(SOURCE, "Foo", "Bar"));
    expect(out).toContain("public class Bar extends Base<Bar> {");
    expect(out).toContain("static final Bar INSTANCE = new Bar();");
    expect(out).toContain("private Bar() { this(1); }");
    expect(out).toContain("  Bar(int x) {}");
    expect(out).toContain("static Bar of() { return Bar.INSTANCE; }");
    expect(out).toContain("return Bar.this;");
    expect(out).toContain('String s = "Foo"; // Foo');
    expect(out).toContain("/** Foo, the original. */");
    expect(out).toContain("List<Bar> all = Bar.list(Bar::of);");
    expect(out).toContain("void Foo() {}");
    expect(out).toContain("class Helper { Bar f; }");
  });

  it("leaves a file that declares no top-level type of the old name", () => {
    expect(renameJavaTypeEdits("class Other { Foo f; }", "Foo", "Bar")).toEqual([]);
  });

  it("renames only between two Java names that differ", () => {
    expect(copiedJavaType("Foo.java", "FooCopy.java")).toEqual({ oldName: "Foo", newName: "FooCopy" });
    expect(copiedJavaType("Foo.java", "Foo copy.java")).toBeNull();
    expect(copiedJavaType("Foo.java", "Foo.java")).toBeNull();
    expect(copiedJavaType("Foo.kt", "Bar.kt")).toBeNull();
    expect(copiedJavaType("Foo.java", "Bar.txt")).toBeNull();
  });

  it("saves the renamed copy through a document", async () => {
    const info = { id: 4, version: 1, text: "public class Foo { Foo() {} }\n" } as DocumentInfo;
    const open = vi.spyOn(commands, "docOpen").mockResolvedValue({ status: "ok", data: info });
    const edit = vi.spyOn(commands, "docEdit").mockResolvedValue({ status: "ok", data: 2 } as never);
    const save = vi.spyOn(commands, "docSave").mockResolvedValue({ status: "ok", data: null } as never);
    const close = vi.spyOn(commands, "docClose").mockResolvedValue({ status: "ok", data: null } as never);
    await renameCopiedJavaType("/p/src/Foo.java", "/p/src/FooCopy.java");
    expect(open).toHaveBeenCalledWith("/p/src/FooCopy.java");
    expect(edit).toHaveBeenCalledWith(4, 1, {
      changes: [
        { from: 13, to: 16, insert: "FooCopy" },
        { from: 19, to: 22, insert: "FooCopy" },
      ],
    });
    expect(save).toHaveBeenCalledWith(4);
    expect(close).toHaveBeenCalledWith(4);
  });

  it("does not open a copy that keeps its name", async () => {
    const open = vi.spyOn(commands, "docOpen");
    await renameCopiedJavaType("/p/a/Foo.java", "/p/b/Foo.java");
    expect(open).not.toHaveBeenCalled();
  });
});
