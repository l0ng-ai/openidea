import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { GitSigningConfig } from "@/platform/ipc";

const FPR = "1234567890123456789012345678901234567890";
const SSH_KEY = "key::ssh-ed25519 AAAA";
let config: GitSigningConfig;
const editSigning = vi.fn(async (..._args: unknown[]) => ({ status: "ok", data: null }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      vcsRoots: vi.fn(async () => ({ status: "ok", data: [{ root: "/project" }] })),
      vcsSigningConfig: vi.fn(async () => ({ status: "ok", data: config })),
      vcsGpgSigningKeys: vi.fn(async () => ({ status: "ok", data: [{ fingerprint: FPR, userId: "Me" }] })),
      vcsSshSigningKeys: vi.fn(async () => ({
        status: "ok",
        data: [{ key: SSH_KEY, comment: "me@example.com", inAgent: true }],
      })),
      vcsEditSigning: (...args: unknown[]) => editSigning(...args),
      cancelRequest: vi.fn(async () => ({ status: "ok", data: null })),
    },
  };
});

import { useProject } from "@/platform/project";
import { GitSigningRow } from "../pages/GitSigningRow";

async function openDialog() {
  render(<GitSigningRow />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Configure GPG Signature…" })));
  await screen.findByText("Signing format");
}

async function choose(current: string, option: string) {
  await act(async () => fireEvent.click(screen.getByLabelText(new RegExp(current))));
  await act(async () => fireEvent.click(await screen.findByRole("option", { name: new RegExp(option) })));
}

beforeEach(() => {
  editSigning.mockClear();
  useProject.setState({ project: { name: "demo", root: "/project", trusted: true } as never });
});

afterEach(() => useProject.setState({ project: null }));

describe("Configure GPG Signature", () => {
  it("saves the SSH format with the chosen SSH key", async () => {
    config = { format: "openpgp", enabled: true, key: FPR };
    await openDialog();
    await choose("Signing format", "SSH");
    await screen.findByText("Sign commits with SSH");
    await choose("Signing key", "me@example.com");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "OK" })));
    expect(editSigning).toHaveBeenCalledWith("/project", { enabled: null, key: SSH_KEY, format: "ssh" });
  });

  it("drops the OpenPGP key when the format changes with signing off", async () => {
    config = { format: "openpgp", enabled: false, key: FPR };
    await openDialog();
    await choose("Signing format", "SSH");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "OK" })));
    expect(editSigning).toHaveBeenCalledWith("/project", { enabled: null, key: null, format: "ssh" });
  });
});
