import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ipc = vi.hoisted(() => ({
  debugJvmMemoryInstances: vi.fn(),
  debugJvmMemoryFields: vi.fn(),
  debugJvmMemoryReferrers: vi.fn(),
  lspWorkspaceSymbols: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

import type {
  DebugCapabilities,
  JvmFieldsResult,
  JvmInspectUnavailable,
  JvmInstancesResult,
  JvmReferrersResult,
  WorkspaceSymbol,
} from "@/platform/ipc";
import { registerActions } from "@/platform/actions";
import { setLocale } from "@/platform/i18n";
import { provideEditorService, provideNotificationService, type EditorService } from "@/workbench/contributions";
import { useDebug, type DebugSession } from "../state";
import { closeInstances, showInstances, showReferrers, useInstances } from "../memory/instancesState";
import { InstancesPane } from "../memory/InstancesPane";
import { jumpToClass } from "../memory/jumpToClass";

const CLASS = "com.x.Order";

const session = {
  id: 1,
  name: "main",
  adapter: "java-debug",
  parent: null,
  launch: null,
  process: null,
  status: "paused",
  stoppedThread: 1,
  stopReason: "breakpoint",
  stopDescription: null,
  threads: [],
  selectedThread: 1,
  frames: [],
  selectedFrame: null,
  hits: 1,
  stops: 0,
  exitCode: null,
  caps: { jvmInstances: true } as DebugCapabilities,
} as DebugSession;

const LIST: JvmInstancesResult = {
  status: "ready",
  generation: 2,
  instances: [
    { kind: "object", id: 12, typeName: CLASS },
    { kind: "string", id: 13, text: "hi", length: 2 },
    { kind: "boxed", id: 14, typeName: "java.lang.Integer", text: "42" },
    { kind: "array", id: 16, typeName: "int[]", length: 3 },
  ],
  truncated: false,
};
const FIELDS: JvmFieldsResult = {
  status: "ready",
  fields: [
    { name: "items", value: { kind: "object", id: 15, typeName: "java.util.ArrayList" } },
    { name: "total", value: { kind: "primitive", typeName: "int", text: "3" } },
  ],
};
const REFERRERS: JvmReferrersResult = {
  status: "ready",
  referrers: [{ value: { kind: "object", id: 3, typeName: "com.x.Book" }, via: ["orders"] }],
  truncated: false,
};
const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const unavailable = (reason: JvmInspectUnavailable) => ({ status: "unavailable" as const, reason });

let unregister: () => void;

async function open(result: JvmInstancesResult = LIST, s: DebugSession = session) {
  ipc.debugJvmMemoryInstances.mockReturnValueOnce(ok(result));
  await showInstances(s.id, CLASS);
  return render(<InstancesPane session={s} />);
}

const item = (text: string) => screen.getByText(text).closest<HTMLElement>("[role=treeitem]")!;
const toggle = (row: HTMLElement) => fireEvent.mouseDown(row.querySelector("[data-tree-toggle]")!, { button: 0 });

beforeEach(() => {
  useInstances.setState({ bySession: {} });
  useDebug.setState({ sessions: { 1: session }, active: 1, stopSeq: 0 });
  for (const m of Object.values(ipc)) m.mockReset();
  // The real actions live in actions.ts; the buttons only need their ids to resolve.
  unregister = registerActions([
    {
      id: "debug.memory.showInstances",
      title: "Show Instances",
      run: ({ arg }) => void showInstances(1, arg as string),
    },
    { id: "debug.memory.jumpToSource", title: "Jump to Source", run: () => {} },
    { id: "debug.memory.closeInstances", title: "Close Instances", run: () => closeInstances(1) },
  ]);
});

afterEach(() => {
  unregister();
  cleanup();
});

describe("InstancesPane", () => {
  it("lists instances with previews", async () => {
    await open();
    expect(screen.getByText(`Instances of ${CLASS}`)).toBeTruthy();
    const tree = screen.getByRole("tree");
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows).toHaveLength(4);
    for (const text of ["Order@12", '"hi"', "42", "int[3]"]) expect(within(tree).getByText(text)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Jump to Source" })).toBeTruthy();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it("says when only the first instances are shown", async () => {
    await open({ ...LIST, truncated: true });
    expect(screen.getByText("Showing the first 4 instances.")).toBeTruthy();
  });

  it("expands fields one level on demand", async () => {
    ipc.debugJvmMemoryFields.mockReturnValue(ok(FIELDS));
    await open();
    const order = item("Order@12");
    expect(order.getAttribute("aria-expanded")).toBe("false");
    toggle(order);
    expect(await screen.findByText("ArrayList@15")).toBeTruthy();
    expect(ipc.debugJvmMemoryFields).toHaveBeenCalledTimes(1);
    expect(ipc.debugJvmMemoryFields).toHaveBeenCalledWith(1, { generation: 2, id: 12 });
    expect(screen.getByText("items")).toBeTruthy();
    // An object field opens further; a primitive does not.
    expect(item("ArrayList@15").getAttribute("aria-expanded")).toBe("false");
    expect(item("3").getAttribute("aria-expanded")).toBeNull();
    toggle(item("Order@12"));
    toggle(item("Order@12"));
    expect(ipc.debugJvmMemoryFields).toHaveBeenCalledTimes(1);
  });

  it("shows referrers with the field that points at the object", async () => {
    ipc.debugJvmMemoryReferrers.mockReturnValue(ok(REFERRERS));
    await open();
    fireEvent.click(within(item("Order@12")).getByRole("button", { name: "Show Referrers" }));
    expect(await screen.findByText("Book@3 · orders")).toBeTruthy();
    expect(ipc.debugJvmMemoryReferrers).toHaveBeenCalledWith(1, { generation: 2, id: 12 }, 50);
    expect(item("Referrers").getAttribute("aria-expanded")).toBe("true");
  });

  it("says when nothing refers to the object", async () => {
    ipc.debugJvmMemoryReferrers.mockReturnValue(ok({ ...REFERRERS, referrers: [] }));
    await open();
    fireEvent.click(within(item("Order@12")).getByRole("button", { name: "Show Referrers" }));
    expect(await screen.findByText("No referrers")).toBeTruthy();
  });

  it("marks the list outdated after another stop and asks again", async () => {
    const { rerender } = await open();
    const banner = "These values are from before the last stop. Show the instances again to update them.";
    expect(screen.queryByText(banner)).toBeNull();
    const later = { ...session, stops: 1 };
    useDebug.setState({ sessions: { 1: later } });
    rerender(<InstancesPane session={later} />);
    expect(screen.getByText(banner)).toBeTruthy();
    expect(item("Order@12").getAttribute("aria-expanded")).toBeNull();
    expect(within(item("Order@12")).getByRole("button", { name: "Show Referrers" }).hasAttribute("disabled")).toBe(
      true,
    );

    ipc.debugJvmMemoryInstances.mockReturnValueOnce(ok({ ...LIST, generation: 3 }));
    fireEvent.click(screen.getByRole("button", { name: "Show Instances" }));
    await waitFor(() => expect(screen.queryByText(banner)).toBeNull());
    expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledTimes(2);
    expect(item("Order@12").getAttribute("aria-expanded")).toBe("false");
  });

  it("explains a collected object", async () => {
    ipc.debugJvmMemoryFields.mockReturnValue(ok(unavailable({ kind: "collected" })));
    await open();
    toggle(item("Order@12"));
    expect(await screen.findByText("The object has been garbage collected.")).toBeTruthy();
  });

  it.each<[JvmInspectUnavailable, string]>([
    [{ kind: "noBackend" }, "This debugger cannot list instances."],
    [{ kind: "unsupported", detail: "no VM" }, "The debugger cannot list instances: no VM"],
    [{ kind: "stale" }, "These values are from before the last stop. Show the instances again to update them."],
    [{ kind: "collected" }, "The object has been garbage collected."],
    [{ kind: "classNotLoaded" }, "The class is not loaded in the JVM."],
    [{ kind: "vmNotFound" }, "Could not tell which JVM this session debugs."],
    [{ kind: "timedOut" }, "The JVM did not answer in time."],
    [{ kind: "backendClosed" }, "The connection to the JVM is closed."],
  ])("words the %j reason", async (reason, text) => {
    await open(unavailable(reason));
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("asks to pause a running program for its instances", async () => {
    const running = { ...session, status: "running" } as DebugSession;
    await open(unavailable({ kind: "notSuspended" }), running);
    expect(screen.getByText("Pause the program to see instances.")).toBeTruthy();
  });

  it("says instances need a breakpoint or step stop when the debugger finds no stop after Pause", async () => {
    await open(unavailable({ kind: "notSuspended" }));
    expect(
      screen.getByText(
        "This debugger lists instances only when the program stops at a breakpoint or after a step, not after Pause.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Pause the program to see instances.")).toBeNull();
  });

  it("retries a list that timed out", async () => {
    await open(unavailable({ kind: "timedOut" }));
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(ok(LIST));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Order@12")).toBeTruthy();
    expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledTimes(2);
    expect(ipc.debugJvmMemoryInstances).toHaveBeenLastCalledWith(1, CLASS, 1000);
  });

  it("retries fields that timed out", async () => {
    ipc.debugJvmMemoryFields.mockReturnValueOnce(ok(unavailable({ kind: "timedOut" })));
    await open();
    toggle(item("Order@12"));
    await screen.findByText("The JVM did not answer in time.");
    ipc.debugJvmMemoryFields.mockReturnValueOnce(ok(FIELDS));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ArrayList@15")).toBeTruthy();
    expect(ipc.debugJvmMemoryFields).toHaveBeenCalledTimes(2);
  });

  it("Enter on a row's Show Referrers button shows that row's referrers, not the lead row's", async () => {
    const user = userEvent.setup();
    ipc.debugJvmMemoryReferrers.mockReturnValue(ok({ ...REFERRERS, referrers: [] }));
    ipc.debugJvmMemoryFields.mockReturnValue(ok({ status: "ready", fields: [] }));
    await open();
    fireEvent.mouseDown(item("Order@12"), { button: 0 });
    within(item('"hi"')).getByRole("button", { name: "Show Referrers" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(ipc.debugJvmMemoryReferrers).toHaveBeenCalledWith(1, { generation: 2, id: 13 }, 50));
    expect(ipc.debugJvmMemoryReferrers).toHaveBeenCalledTimes(1);
    expect(item("Order@12").getAttribute("aria-expanded")).toBe("false");
    expect(item('"hi"').getAttribute("aria-expanded")).toBe("true");
  });

  it("Enter on the tree still opens the lead row", async () => {
    ipc.debugJvmMemoryFields.mockReturnValue(ok(FIELDS));
    await open();
    fireEvent.mouseDown(item("Order@12"), { button: 0 });
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter" });
    expect(await screen.findByText("ArrayList@15")).toBeTruthy();
    expect(item("Order@12").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the lead object row in the store for the Show Referrers action", async () => {
    await open();
    expect(useInstances.getState().bySession[1]!.lead).toBeNull();
    fireEvent.mouseDown(item('"hi"'), { button: 0 });
    expect(useInstances.getState().bySession[1]!.lead).toEqual({ key: "#1", ref: { generation: 2, id: 13 } });
  });

  it("opens the referrers the store was asked to show", async () => {
    ipc.debugJvmMemoryReferrers.mockReturnValue(ok(REFERRERS));
    ipc.debugJvmMemoryFields.mockReturnValue(ok(FIELDS));
    await open();
    showReferrers(1, "#0", { generation: 2, id: 12 });
    expect(await screen.findByText("Book@3 · orders")).toBeTruthy();
    expect(item("Order@12").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("ArrayList@15")).toBeTruthy();
  });

  it("closes", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Close Instances" }));
    expect(useInstances.getState().bySession[1]).toBeUndefined();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("shows Chinese text in zh", async () => {
    await setLocale("zh");
    try {
      ipc.debugJvmMemoryReferrers.mockReturnValue(ok(REFERRERS));
      await open();
      expect(screen.getByText(`${CLASS} 的实例`)).toBeTruthy();
      expect(screen.getByRole("button", { name: "关闭实例列表" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "跳转到源代码" })).toBeTruthy();
      fireEvent.click(within(item("Order@12")).getByRole("button", { name: "显示引用者" }));
      expect(await screen.findByText("引用者")).toBeTruthy();
    } finally {
      await setLocale("en");
    }
  });
});

describe("jumpToClass", () => {
  const symbol = (container: string, path: string, line = 4): WorkspaceSymbol => ({
    name: "Order",
    kind: "class",
    container,
    location: { path, range: { start: { line, col: 13 }, end: { line, col: 18 } } },
  });
  const openFile = vi.fn<EditorService["openFile"]>();
  const notify = vi.fn();

  beforeEach(() => {
    openFile.mockReset().mockResolvedValue(undefined);
    notify.mockReset();
    provideEditorService({ openFile } as unknown as EditorService);
    provideNotificationService({ notify });
  });

  it("opens the class whose package matches", async () => {
    ipc.lspWorkspaceSymbols.mockReturnValue(
      ok([symbol("com.a", "/p/com/a/Order.java"), symbol("com.x", "/p/com/x/Order.java", 9)]),
    );
    await expect(jumpToClass("com.x.Order")).resolves.toBe(true);
    expect(ipc.lspWorkspaceSymbols).toHaveBeenCalledWith(expect.anything(), "Order");
    expect(openFile).toHaveBeenCalledWith("/p/com/x/Order.java", { selection: { line: 9, col: 13 } });
  });

  it("opens the outer class of a nested class or an array", async () => {
    ipc.lspWorkspaceSymbols.mockReturnValue(ok([symbol("com.x", "/p/com/x/Order.java")]));
    await expect(jumpToClass("com.x.Order$Line[][]")).resolves.toBe(true);
    expect(ipc.lspWorkspaceSymbols).toHaveBeenCalledWith(expect.anything(), "Order");
    expect(openFile).toHaveBeenCalledWith("/p/com/x/Order.java", { selection: { line: 4, col: 13 } });
  });

  it("accepts a container that ends with the package", async () => {
    ipc.lspWorkspaceSymbols.mockReturnValue(ok([symbol("app.jar com.x", "jdt://contents/Order.class")]));
    await expect(jumpToClass("com.x.Order")).resolves.toBe(true);
    expect(openFile).toHaveBeenCalledWith("jdt://contents/Order.class", { selection: { line: 4, col: 13 } });
  });

  it("says when no source is found", async () => {
    ipc.lspWorkspaceSymbols.mockReturnValue(ok([symbol("com.a", "/p/com/a/Order.java"), symbol("com.ax", "/x")]));
    await expect(jumpToClass("com.x.Order")).resolves.toBe(false);
    expect(openFile).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not find the source of com.x.Order." }),
    );
  });
});
