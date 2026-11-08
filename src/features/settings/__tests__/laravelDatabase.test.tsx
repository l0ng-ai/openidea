import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  dbSources: vi.fn(async () => ({
    status: "ok" as const,
    data: [{ id: "s1", name: "app", driver: "sqlite" }],
  })),
  phpLaravelRefreshSchema: vi.fn(),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const { PageContext } = await import("../components/context");
const { validateSettings } = await import("../model/schema");
const { stage, useSettingsDialog } = await import("../model/staging");
const { LaravelDatabaseRow, refreshLaravelSchema } = await import("../languages/LaravelDatabase");

const savedDialog = useSettingsDialog.getState();
afterEach(() => {
  cleanup();
  useSettingsDialog.setState(savedDialog, true);
  ipc.phpLaravelRefreshSchema.mockReset();
});

const mount = (database = "") => {
  const base = validateSettings({});
  useSettingsDialog.setState({ base, globalBase: base, staged: {} });
  if (database) stage("languages.php", "project", "languages.php.laravel.database", database);
  return render(
    <PageContext.Provider value={{ pageId: "languages.php", scope: "project" }}>
      <LaravelDatabaseRow />
    </PageContext.Provider>,
  );
};

describe("Settings › PHP › Laravel › Database", () => {
  it("describes what reading the schema found", async () => {
    ipc.phpLaravelRefreshSchema.mockResolvedValueOnce({ status: "ok", data: { source: "app", tables: 3 } });
    expect(await refreshLaravelSchema()).toBe("Schema of app read (tables: 3)");
    ipc.phpLaravelRefreshSchema.mockResolvedValueOnce({ status: "ok", data: null });
    expect(await refreshLaravelSchema()).toBe("No data source is chosen: the migrations alone are used");
    ipc.phpLaravelRefreshSchema.mockResolvedValueOnce({
      status: "error",
      error: { kind: "unavailable", message: "no database file" },
    });
    expect(await refreshLaravelSchema()).toBe("Could not read the schema: no database file");
  });

  it("offers no refresh without a data source", () => {
    mount();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Refresh Schema" }).disabled).toBe(true);
  });

  it("refreshes the chosen data source's schema on demand", async () => {
    ipc.phpLaravelRefreshSchema.mockResolvedValue({ status: "ok", data: { source: "app", tables: 2 } });
    mount("s1");
    await waitFor(() => expect(ipc.dbSources).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Refresh Schema" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Schema of app read (tables: 2)"));
    expect(ipc.phpLaravelRefreshSchema).toHaveBeenCalledTimes(1);
  });
});
