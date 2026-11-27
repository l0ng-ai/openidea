import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ServiceTab } from "@/bindings";
import { getAction, registerAction } from "@/platform/actions";
import { setLocale, tx, VerbatimTextContext } from "@/platform/i18n";
import { Button, EmptyState } from "@/ui";
import { InputDialogsHost, pickItems } from "@/workbench/inputDialogs";
import { confirm, MessagesHost } from "@/workbench/messages";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { ServicePane } from "../views/ServicePane";

// "Pick", "Refresh" and "Log" are IDE text too ("拣选", "刷新", "日志"); a plugin means its own.
beforeEach(async () => {
  await setLocale("zh");
});

afterEach(async () => {
  cleanup();
  setPluginsBackend(null);
  await setLocale("en");
});

describe("plugin text", () => {
  it("primitives show given text as written below plugin UI, their own words translated", () => {
    render(
      <>
        <Button>Refresh</Button>
        <VerbatimTextContext.Provider value={true}>
          <Button>Refresh</Button>
          <EmptyState title="Log" />
        </VerbatimTextContext.Provider>
      </>,
    );
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByText("Log")).toBeTruthy();
  });

  it("keeps a plugin command's title, translating its IDE category", () => {
    const disposers = [
      registerAction({ id: "test.ide.pick", title: "Pick", category: "Tools", run: () => {} }),
      registerAction({ id: "test.plugin.pick", title: "Pick", category: "Tools", verbatim: true, run: () => {} }),
    ];
    expect(getAction("test.ide.pick")?.title).toBe(tx("Pick"));
    expect(getAction("test.plugin.pick")?.title).toBe("Pick");
    expect(getAction("test.plugin.pick")?.category).toBe(tx("Tools"));
    for (const d of disposers) d();
  });

  it("shows a plugin's service tabs as written", async () => {
    const tabs: ServiceTab[] = [{ id: "log", label: "Log", body: { kind: "text", value: "a: 1" } }];
    setPluginsBackend({ ...createMemoryPluginsBackend([]), serviceDetail: async () => tabs });
    render(<ServicePane pluginId="kube" view="pods" itemKey="pod:a" />);
    expect(await screen.findByRole("tab", { name: "Log" })).toBeTruthy();
  });

  it("asks a plugin's questions as written, with the IDE's own buttons translated", async () => {
    render(
      <>
        <InputDialogsHost />
        <MessagesHost />
      </>,
    );
    act(() => {
      void pickItems({ title: "Pick", items: [{ key: "a", label: "Log" }], multiple: false, verbatim: true });
    });
    expect(await screen.findByRole("dialog", { name: "Pick" })).toBeTruthy();
    expect(screen.getByText("Log")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确定" })).toBeTruthy();
    cleanup();

    render(<MessagesHost />);
    act(() => {
      void confirm({ title: "Pick", message: "Refresh", ok: tx("OK"), verbatim: true });
    });
    expect(await screen.findByRole("dialog", { name: "Pick" })).toBeTruthy();
    expect(screen.getByText("Refresh")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确定" })).toBeTruthy();
  });
});
