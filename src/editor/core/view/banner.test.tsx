import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { registerEditorBanner } from "@/workbench/contributions";
import { useDocMeta, type DocMeta } from "../model/document";
import { documentBanner, EditorBanners, VirtualBanner } from "./Banner";

describe("editor banners", () => {
  it.each([
    ["jdt://contents/lib.jar/p/Lib.class", true, "Decompiled .class file: sources are not available."],
    ["csharp:/p/App.csproj/decompiled/Lib.cs", true, "Decompiled assembly (read-only)."],
    ["csharp:/p/App.csproj/generated/Lib.g.cs", false, "Library source (read-only)."],
  ])("describes %s", (path, decompiled, text) => {
    render(<VirtualBanner path={path} decompiled={decompiled} description="Example.Library" />);
    expect(screen.getByRole("status").textContent).toContain(text);
    expect(screen.getByTitle("Example.Library")).toBeTruthy();
  });

  it("shows the document notice through the banner extension point, before contributed ones", () => {
    const off = [
      registerEditorBanner(documentBanner),
      registerEditorBanner({ id: "test.other", useBanner: () => ({ text: "Other notice" }) }),
    ];
    act(() => useDocMeta.setState({ "/p/a.bin": { banner: "binary" } as DocMeta }));
    render(<EditorBanners path="/p/a.bin" />);
    const notices = screen.getAllByRole("status").map((n) => n.textContent);
    expect(notices).toEqual(["This file appears to be binary and is shown read-only.", "Other notice"]);
    act(() => useDocMeta.setState({ "/p/a.bin": { banner: null } as DocMeta }));
    expect(screen.getAllByRole("status").map((n) => n.textContent)).toEqual(["Other notice"]);
    off.forEach((f) => f());
  });
});
