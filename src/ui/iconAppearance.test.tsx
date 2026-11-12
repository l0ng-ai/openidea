import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { Tree } from "./Tree";
import { setIconAppearance } from "./iconAppearance";

const root = () => document.documentElement;

afterEach(() => setIconAppearance(null));

describe("icon appearance", () => {
  it("applies monochrome, saturation, opacity, accent and tree icon size to the document", () => {
    setIconAppearance({ monochrome: "#546E7A", saturation: 10, opacity: 60, accent: "#009688", iconSize: 20 });
    expect(root().style.getPropertyValue("--oi-icon-filter")).toBe("url(#oi-icon-mono) saturate(0.5)");
    expect(root().style.getPropertyValue("--oi-icon-opacity")).toBe("0.6");
    expect(root().style.getPropertyValue("--oi-icon-accent")).toBe("#009688");
    expect(root().style.getPropertyValue("--oi-tree-icon-size")).toBe("20px");
    expect(root().dataset.oiIconFilter).toBe("");
    expect(root().dataset.oiAccent).toBe("");
    expect(document.querySelector("#oi-icon-mono feColorMatrix")?.getAttribute("values")).toContain("0.");

    setIconAppearance(null);
    expect(root().style.getPropertyValue("--oi-icon-filter")).toBe("");
    expect(root().dataset.oiIconFilter).toBeUndefined();
    expect(root().dataset.oiAccent).toBeUndefined();
    expect(root().dataset.oiTreeIconSize).toBeUndefined();
  });

  it("uses the theme row height in trees that do not set their own", () => {
    const roots = [{ key: "a", label: "a" }];
    const { container } = render(
      <Tree
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => n.label}
        getChildren={() => undefined}
        isExpandable={() => false}
        aria-label="t"
      />,
    );
    const row = () => container.querySelector<HTMLElement>('[role="treeitem"]');
    expect(row()?.style.height).toBe("24px");
    act(() => setIconAppearance({ rowHeight: 30 }));
    expect(row()?.style.height).toBe("30px");
  });
});
