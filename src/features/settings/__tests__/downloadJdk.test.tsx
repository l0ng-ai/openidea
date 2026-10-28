import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InstallEvent, Sdk } from "@/platform/ipc";

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      jdkDownloadVendors: async () => [{ id: "temurin", name: "Eclipse Temurin" }],
      jdkDownloadReleases: async () =>
        ok({ versions: [26, 25, 21, 17, 11, 8], lts: [8, 11, 17, 21, 25], recommended: 25 }),
      jdkDownloadLocation: async () => ok("/data/tools/jdks"),
      cancelRequest: async () => ok(null),
    },
  };
});

const SDK: Sdk = {
  path: "/data/tools/jdks/temurin-25.0.1",
  name: "Eclipse Adoptium 25.0.1",
  version: "25.0.1",
  source: "downloaded",
  home: "/data/tools/jdks/temurin-25.0.1",
  extra: null,
};
let finish: (sdk: Sdk) => void = () => {};
const cancel = vi.fn();
const downloadJdk = vi.fn((_v: string, _n: number, _l: string | null, onEvent: (e: InstallEvent) => void) => {
  onEvent({ type: "progress", fraction: 0.25, message: "Downloaded 50.0 of 200.0 MB" });
  return { promise: new Promise<Sdk>((r) => (finish = r)), cancel };
});
vi.mock("@/platform/jdk", async (orig) => ({ ...(await orig<typeof import("@/platform/jdk")>()), downloadJdk }));

const { DownloadJdkDialog } = await import("../languages/DownloadJdkDialog");
const { useSdks } = await import("../languages/api");

afterEach(() => vi.clearAllMocks());

describe("Download JDK dialog", () => {
  it("downloads the newest LTS into the IDE's JDK folder, with progress, and selects it", async () => {
    const onDownloaded = vi.fn();
    const onClose = vi.fn();
    render(<DownloadJdkDialog onClose={onClose} onDownloaded={onDownloaded} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Version" })).toHaveTextContent("25"));
    expect(screen.getByRole("button", { name: "Vendor" })).toHaveTextContent("Eclipse Temurin");
    await waitFor(() => expect(screen.getByLabelText("Location:")).toHaveValue("/data/tools/jdks"));

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(downloadJdk).toHaveBeenCalledWith("temurin", 25, "/data/tools/jdks", expect.any(Function));
    expect(screen.getByRole("progressbar", { name: "Downloading JDK" })).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();

    // Closing while downloading cancels the download.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(cancel).toHaveBeenCalled();

    await act(async () => finish(SDK));
    expect(onDownloaded).toHaveBeenCalledWith(SDK);
    expect(useSdks.getState().byKind.jdk?.[0]).toEqual(SDK);
  });

  it("preselects the version a fix asks for", async () => {
    render(<DownloadJdkDialog initialVersion={21} onClose={() => {}} onDownloaded={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
    // The version list loads after the Download button enables on a busy runner.
    await waitFor(() => expect(screen.getByRole("button", { name: "Version" })).toHaveTextContent("21"));
  });
});
