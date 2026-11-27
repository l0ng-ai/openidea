import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "@/platform/ipc";

const backend = vi.hoisted(() => ({
  save: vi.fn(),
  password: vi.fn(),
  sshSecret: vi.fn(),
  sources: vi.fn(),
  connected: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      dbSaveSources: backend.save,
      dbSetPassword: backend.password,
      dbSetSshSecret: backend.sshSecret,
      dbSources: backend.sources,
      dbConnected: backend.connected,
    },
  };
});
import { DatabaseDialogs } from "./Dialogs";
import { useDatabase } from "./store";

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const mysql: DataSource = { id: "my", name: "MySQL", driver: "mysql", user: "manage" };
const tunnelled: DataSource = {
  ...mysql,
  ssh: { enabled: true, host: "bastion", port: 22, user: "u", auth: "password", saveSecret: false },
} as DataSource;

function ask(kind: "password" | "sshSecret", source: DataSource) {
  const resolve = vi.fn();
  useDatabase.setState({
    sources: [source],
    dialog: kind === "password" ? { kind, source, resolve } : { kind, source, prompt: "password required", resolve },
  });
  render(<DatabaseDialogs />);
  return resolve;
}

function answer(secret: string) {
  fireEvent.change(document.querySelector("input[type=password]")!, { target: { value: secret } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Save password" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

beforeEach(() => {
  for (const m of Object.values(backend)) m.mockReset();
  backend.save.mockResolvedValue(ok(null));
  backend.password.mockResolvedValue(ok(null));
  backend.sshSecret.mockResolvedValue(ok(null));
  backend.sources.mockImplementation(async () => ok(backend.save.mock.calls.at(-1)?.[0] ?? [mysql]));
  backend.connected.mockResolvedValue(ok([]));
});

describe("connect-time secret prompts", () => {
  it("turns on the data source's Save password when it is ticked in the prompt", async () => {
    const resolve = ask("password", mysql);
    answer("secret");
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(true));
    expect(backend.save).toHaveBeenCalledWith([{ ...mysql, savePassword: true }]);
    expect(backend.password).toHaveBeenCalledWith("my", "secret", true);
  });

  it("only stores the password when the setting already matches", async () => {
    const resolve = ask("password", { ...mysql, savePassword: true });
    fireEvent.change(document.querySelector("input[type=password]")!, { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(true));
    expect(backend.save).not.toHaveBeenCalled();
    expect(backend.password).toHaveBeenCalledWith("my", "secret", true);
  });

  it("turns on the SSH tunnel's Save password of the data source's own SSH settings", async () => {
    const resolve = ask("sshSecret", tunnelled);
    answer("ssh-secret");
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(true));
    expect(backend.save).toHaveBeenCalledWith([{ ...tunnelled, ssh: { ...tunnelled.ssh, saveSecret: true } }]);
    expect(backend.sshSecret).toHaveBeenCalledWith("my", "ssh-secret", true);
  });
});
