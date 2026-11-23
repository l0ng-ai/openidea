import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commands } from "@/platform/ipc";
import { ExportTestResultsDialog, defaultExportName, loadExportOptions } from "./ExportTestResultsDialog";
import { TestResults } from "./testing";

const actions = vi.hoisted(() => ({ executeAction: vi.fn(async () => {}) }));
vi.mock("@/platform/actions", async (orig) => ({ ...(await orig<object>()), executeAction: actions.executeAction }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));
const messages = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock("@/workbench/messages", async (orig) => ({ ...(await orig<object>()), confirm: messages.confirm }));
const dialog = vi.hoisted(() => ({ save: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("@/platform/dialog", () => dialog);

const ok = { status: "ok", data: null } as const;
let onDisk: Record<string, "file" | "dir"> = {};
let written: { path: string; text: string }[] = [];

beforeEach(() => {
  localStorage.clear();
  onDisk = {};
  written = [];
  vi.spyOn(commands, "fsEntryKind").mockImplementation(async (path) =>
    onDisk[path]
      ? { status: "ok", data: onDisk[path] }
      : { status: "error", error: { kind: "NotFound", message: path } as never },
  );
  vi.spyOn(commands, "fsDelete").mockImplementation(async (path) => {
    delete onDisk[path];
    return ok;
  });
  vi.spyOn(commands, "fsOpenWithSystem").mockResolvedValue(ok);
  vi.spyOn(commands, "fsCreateFileBytes").mockImplementation(async (path, data) => {
    written.push({ path, text: new TextDecoder().decode(new Uint8Array(data)) });
    return ok;
  });
});
afterEach(() => vi.restoreAllMocks());

function results() {
  const r = new TestResults();
  r.apply([
    { type: "result", path: ["calc", "TestAdd"], status: "passed", durationMs: 3 },
    { type: "result", path: ["calc", "TestSub"], status: "failed", durationMs: 12 },
  ]);
  r.finish(1);
  return r;
}

function open(onClose = vi.fn()) {
  render(<ExportTestResultsDialog results={results()} name="go test ./calc" cwd="/work/app/" onClose={onClose} />);
  return onClose;
}

const file = () => screen.getByLabelText("File name");
const folder = () => screen.getByLabelText("Folder");
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("ExportTestResultsDialog", () => {
  it("writes an HTML report to the project folder and opens it in the browser", async () => {
    const onClose = open();
    expect(file()).toHaveValue("Test Results - go test _calc.html");
    expect(folder()).toHaveValue("/work/app/");
    expect(screen.getByRole("radio", { name: "HTML" })).toBeChecked();
    press("OK");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe("/work/app/Test Results - go test _calc.html");
    expect(written[0]!.text).toContain("<title>Test Results - go test ./calc</title>");
    expect(commands.fsDelete).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "info", body: written[0]!.path }));
    expect(commands.fsOpenWithSystem).toHaveBeenCalledWith(written[0]!.path);
    expect(actions.executeAction).not.toHaveBeenCalled();
  });

  it("opens a report outside the project through the built-in server", async () => {
    vi.mocked(commands.fsOpenWithSystem).mockResolvedValueOnce({
      status: "error",
      error: { kind: "PermissionDenied", message: "outside the project" } as never,
    });
    const onClose = open();
    fireEvent.change(file(), { target: { value: "/tmp/out.html" } });
    press("OK");
    await waitFor(() =>
      expect(actions.executeAction).toHaveBeenCalledWith("web.openInBrowser", { path: "/tmp/out.html" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("switches the extension with the format, keeps XML out of the browser, and remembers the choice", async () => {
    const onClose = open();
    fireEvent.click(screen.getByRole("radio", { name: "XML" }));
    expect(file()).toHaveValue("Test Results - go test _calc.xml");
    // Only an HTML report opens in the browser.
    expect(screen.getByRole("checkbox", { name: "Open exported file in browser" })).toBeDisabled();
    press("OK");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(written[0]!.text).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<testrun /);
    expect(commands.fsOpenWithSystem).not.toHaveBeenCalled();
    expect(loadExportOptions()).toEqual({ format: "xml", openInBrowser: true });
  });

  it("doesn't open the browser when unticked", async () => {
    const onClose = open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Open exported file in browser" }));
    press("OK");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(written).toHaveLength(1);
    expect(commands.fsOpenWithSystem).not.toHaveBeenCalled();
    expect(loadExportOptions().openInBrowser).toBe(false);
  });

  it("resolves a relative path against the working directory", async () => {
    const onClose = open();
    fireEvent.change(file(), { target: { value: "  reports/out.html " } });
    press("OK");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(written[0]!.path).toBe("/work/app/reports/out.html");
  });

  it("asks before replacing a file, and keeps it when the answer is no", async () => {
    onDisk["/work/app/out.html"] = "file";
    messages.confirm.mockResolvedValueOnce(false);
    const onClose = open();
    fireEvent.change(file(), { target: { value: "/work/app/out.html" } });
    press("OK");
    await waitFor(() => expect(messages.confirm).toHaveBeenCalledTimes(1));
    expect(messages.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "File 'out.html' already exists. Do you want to overwrite it?" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "OK" })).toBeEnabled());
    expect(written).toHaveLength(0);
    expect(commands.fsDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    messages.confirm.mockResolvedValueOnce(true);
    press("OK");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(commands.fsDelete).toHaveBeenCalledWith("/work/app/out.html");
    expect(written.map((w) => w.path)).toEqual(["/work/app/out.html"]);
  });

  it("doesn't ask again for a file the save dialog already confirmed", async () => {
    const path = "C:\\reports\\picked.html";
    onDisk[path] = "file";
    dialog.save.mockResolvedValueOnce(path);
    const onClose = open();
    press("Browse…");
    await waitFor(() => expect(file()).toHaveValue("picked.html"));
    expect(folder()).toHaveValue("C:\\reports\\");
    expect(dialog.save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "/work/app/Test Results - go test _calc.html",
        filters: [{ name: "HTML", extensions: ["html"] }],
      }),
    );
    press("OK");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(messages.confirm).not.toHaveBeenCalled();
    expect(written.map((w) => w.path)).toEqual([path]);
  });

  it("confirms again when the destination changes after using the save dialog", async () => {
    dialog.save.mockResolvedValueOnce("/tmp/picked.html");
    onDisk["/work/app/reports/picked.html"] = "file";
    messages.confirm.mockResolvedValueOnce(false);
    open();
    press("Browse…");
    await waitFor(() => expect(file()).toHaveValue("picked.html"));
    fireEvent.change(folder(), { target: { value: "reports" } });
    press("OK");
    await waitFor(() => expect(messages.confirm).toHaveBeenCalledOnce());
    expect(written).toHaveLength(0);
  });

  it("reports a directory or a failed write and stays open", async () => {
    onDisk["/work/app/reports"] = "dir";
    const onClose = open();
    fireEvent.change(file(), { target: { value: "/work/app/reports" } });
    press("OK");
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ level: "error", body: "/work/app/reports is a directory" }),
      ),
    );
    expect(written).toHaveLength(0);

    vi.mocked(commands.fsCreateFileBytes).mockResolvedValueOnce({
      status: "error",
      error: { kind: "PermissionDenied", message: "permission denied" } as never,
    });
    fireEvent.change(file(), { target: { value: "/ro/out.html" } });
    press("OK");
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(onClose).not.toHaveBeenCalled();
    expect(actions.executeAction).not.toHaveBeenCalled();
  });

  it("can't export to an empty path", () => {
    open();
    fireEvent.change(file(), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
  });
});

describe("defaultExportName", () => {
  it("replaces characters file systems refuse in the configuration's name", () => {
    expect(defaultExportName('a/b\\c:d*e?f"g<h>i|j', "xml")).toBe("Test Results - a_b_c_d_e_f_g_h_i_j.xml");
    expect(defaultExportName("go test ./...", "html")).toBe("Test Results - go test.html");
    expect(defaultExportName("Tests in 'com.acme.Cart'", "html")).toBe("Test Results - Tests in 'com_acme_Cart'.html");
    expect(defaultExportName("...", "html")).toBe("Test Results - Tests.html");
  });
});
