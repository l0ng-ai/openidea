import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { Sdk } from "@/platform/ipc";

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const jdk = (version: string): Sdk => ({
  path: `/jdks/jdk-${version}`,
  name: `JDK ${version}`,
  version,
  source: "system",
  home: `/jdks/jdk-${version}`,
  extra: null,
});
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      sdkDetect: async () => ok([jdk("21.0.3"), jdk("25.0.1")]),
      jdtlsRequiredJava: async () => ok(25),
    },
  };
});

const { SdkField, javaMajor, useJdtlsJdk } = await import("../languages/components");

describe("language server JDK", () => {
  it("reads the feature release of JDK versions", () => {
    expect(javaMajor("21.0.3")).toBe(21);
    expect(javaMajor("25")).toBe(25);
    expect(javaMajor("1.8.0_392")).toBe(8);
    expect(javaMajor(null)).toBeNull();
  });

  it("states what the installed jdtls needs and whether the chosen JDK meets it", async () => {
    const { result, rerender } = renderHook(({ value }) => useJdtlsJdk("Runs jdtls.", value), {
      initialProps: { value: "/jdks/jdk-21.0.3" },
    });
    await waitFor(() =>
      expect(result.current.hint).toBe(
        "Runs jdtls. The installed jdtls needs JDK 25 or newer; the selected JDK 21 is too old for it.",
      ),
    );
    expect(result.current.minJava).toBe(25);
    rerender({ value: "/jdks/jdk-25.0.1" });
    expect(result.current.hint).toBe("Runs jdtls. The installed jdtls needs JDK 25 or newer.");
    rerender({ value: "" });
    expect(result.current.hint).toBe("Runs jdtls. The installed jdtls needs JDK 25 or newer.");
  });

  it("marks JDKs older than jdtls needs", async () => {
    render(
      <SdkField
        kind="jdk"
        value="/jdks/jdk-21.0.3"
        onChange={() => {}}
        browseTitle="Select"
        aria-label="Language server JDK"
        minJava={25}
      />,
    );
    const combo = screen.getByRole("button", { name: "Language server JDK" });
    await waitFor(() => expect(combo).toHaveTextContent("JDK 21.0.3"));
    fireEvent.click(combo);
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("too old, needs JDK 25+ · /jdks/jdk-21.0.3");
    expect(options[1]).toHaveTextContent("/jdks/jdk-25.0.1");
    expect(options[1]).not.toHaveTextContent("too old");
  });
});
