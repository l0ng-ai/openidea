import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { registerAction } from "@/platform/actions";
import { ServerStatus } from "./ServerStatus";
import { useServers, type ServerEntry } from "./servers";

const ISSUE_49 =
  "jdtls needs JDK 25 or newer to run (found JDK 8, 17, 21). Download JDK 25, or pick an installed one in Settings › Languages & Frameworks › Java › Language Server › JDK (it restarts automatically); the project can still target an older Java version.";

const server = (status: ServerEntry["status"], message: string | null): ServerEntry =>
  ({ id: 1, name: "jdtls", status, message, languages: ["Java"], root: null }) as unknown as ServerEntry;

afterEach(() => useServers.setState({ servers: new Map() }));

describe("Language server status popup", () => {
  it("offers Download JDK N when jdtls can't start for want of a JDK", () => {
    const run = vi.fn();
    const off = registerAction({ id: "java.downloadJdk", title: "Download JDK…", run: ({ arg }) => run(arg) });
    useServers.setState({ servers: new Map([[1 as never, server("misconfigured", ISSUE_49)]]) });
    render(<ServerStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Language servers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download JDK 25" }));
    expect(run).toHaveBeenCalledWith({ version: 25, languageServer: true });
    off();
  });

  it("keeps Restart for other failures", () => {
    useServers.setState({ servers: new Map([[1 as never, server("crashed", "exit code 1")]]) });
    render(<ServerStatus />);
    fireEvent.click(screen.getByRole("button", { name: /Language servers/ }));
    expect(screen.queryByRole("button", { name: /Download JDK/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Restart jdtls" })).toBeInTheDocument();
  });
});
