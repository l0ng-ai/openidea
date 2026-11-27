import { describe, expect, it, vi } from "vitest";
import { IpcError } from "@/platform/ipc";
import { writeBeside } from "./convert";
import { notebookCells, notebookToScript, scriptToCells, scriptToNotebook } from "./script";

describe("notebookToScript", () => {
  it("writes # %% cells, comments Markdown, raw cells and IPython-only lines", () => {
    const script = notebookToScript([
      { cellType: "markdown", source: "# Title\n\nSome *text*" },
      { cellType: "code", source: "%matplotlib inline\nimport os\n!pip list\nx = 1\n" },
      { cellType: "code", source: "%%bash\necho hi" },
      { cellType: "raw", source: "raw text" },
      { cellType: "code", source: "" },
    ]);
    expect(script).toBe(
      [
        "# %% [markdown]\n# # Title\n#\n# Some *text*",
        "# %%\n# %matplotlib inline\nimport os\n# !pip list\nx = 1",
        "# %%\n# %%bash\n# echo hi",
        "# %% [raw]\n# raw text",
        "# %%",
      ].join("\n\n") + "\n",
    );
  });

  it("keeps an empty notebook empty", () => {
    expect(notebookToScript([])).toBe("");
  });
});

describe("scriptToCells", () => {
  it("reads the cells notebookToScript writes", () => {
    const cells = [
      { cellType: "markdown", source: "# Title\n\nSome *text*" },
      { cellType: "code", source: "import os\nx = 1" },
      { cellType: "raw", source: "raw text" },
    ];
    expect(scriptToCells(notebookToScript(cells))).toEqual(cells);
  });

  it("accepts #%% and md markers and keeps text before the first marker", () => {
    expect(scriptToCells("import sys\n\n#%% md\n# Notes\n#%%\nprint(1)\r\n")).toEqual([
      { cellType: "code", source: "import sys" },
      { cellType: "markdown", source: "Notes" },
      { cellType: "code", source: "print(1)" },
    ]);
  });

  it("makes a script without markers one code cell", () => {
    expect(scriptToCells("print(1)\n\nprint(2)\n")).toEqual([{ cellType: "code", source: "print(1)\n\nprint(2)" }]);
    expect(scriptToCells("")).toEqual([]);
  });
});

describe("scriptToNotebook", () => {
  it("writes nbformat 4.5 with a Python kernelspec", () => {
    let n = 0;
    const nb = JSON.parse(scriptToNotebook("# %% [markdown]\n# Hi\n# %%\na = 1\nprint(a)", () => `c${n++}`));
    expect(nb.nbformat).toBe(4);
    expect(nb.nbformat_minor).toBe(5);
    expect(nb.metadata.kernelspec.name).toBe("python3");
    expect(nb.cells).toEqual([
      { cell_type: "markdown", id: "c0", metadata: {}, source: ["Hi"] },
      {
        cell_type: "code",
        id: "c1",
        metadata: {},
        source: ["a = 1\n", "print(a)"],
        execution_count: null,
        outputs: [],
      },
    ]);
  });
});

describe("notebookCells", () => {
  it("joins list sources", () => {
    const text = JSON.stringify({ nbformat: 4, cells: [{ cell_type: "code", source: ["a\n", "b"] }] });
    expect(notebookCells(text)).toEqual([{ cellType: "code", source: "a\nb" }]);
  });

  it("refuses other formats", () => {
    expect(() => notebookCells(JSON.stringify({ nbformat: 3, worksheets: [] }))).toThrow(/nbformat 4/);
    expect(() => notebookCells("not json")).toThrow();
  });
});

describe("writeBeside", () => {
  it("picks the next free name", async () => {
    const taken = new Set(["/p/nb.py", "/p/nb-1.py"]);
    const create = vi.fn(async (path: string) => {
      if (taken.has(path)) throw new IpcError({ kind: "alreadyExists", message: "exists" });
      return null;
    });
    await expect(writeBeside("/p/nb.ipynb", ".py", "x", create)).resolves.toBe("/p/nb-2.py");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("stops on other errors", async () => {
    const create = vi.fn(async () => {
      throw new IpcError({ kind: "permissionDenied", message: "no" });
    });
    await expect(writeBeside("/p/a.py", ".ipynb", "x", create)).rejects.toThrow("no");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
