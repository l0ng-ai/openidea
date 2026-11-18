import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({
  config: new Map<string, string>(),
  set: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      vcsConfigGet: async (repo: string | null, key: string) => ({
        status: "ok" as const,
        data: git.config.get(`${repo ?? ""}:${key}`) ?? null,
      }),
      vcsSetUserIdentity: async (...args: unknown[]) => {
        git.set(...args);
        return { status: "ok" as const, data: null };
      },
    },
  };
});
import { ensureCommitIdentity, identityError } from "./commitIdentity";
import { VcsDialogHost } from "./dialogs";

beforeEach(() => {
  git.config.clear();
  git.set.mockReset();
});

function configure(root: string, name: string, email: string) {
  git.config.set(`${root}:user.name`, name);
  git.config.set(`${root}:user.email`, email);
}

it("commits without asking when every repository has a user name and email", async () => {
  configure("", "Ann", "ann@example.com");
  await expect(ensureCommitIdentity([null], false)).resolves.toBe(true);
  expect(git.set).not.toHaveBeenCalled();
});

it("asks for the identity and sets it globally by default", async () => {
  render(<VcsDialogHost />);
  let done!: Promise<boolean>;
  act(() => void (done = ensureCommitIdentity([null], false)));
  const name = await screen.findByLabelText("Name:");
  fireEvent.change(name, { target: { value: "Ann" } });
  fireEvent.click(screen.getByRole("button", { name: "Set and Commit" }));
  expect(screen.getByRole("alert").textContent).toBe("You need to specify username and email for Git");
  fireEvent.change(screen.getByLabelText("E-mail:"), { target: { value: "ann.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Set and Commit" }));
  expect(screen.getByRole("alert").textContent).toBe("The email address must contain the '@' symbol");
  fireEvent.change(screen.getByLabelText("E-mail:"), { target: { value: " ann@example.com " } });
  fireEvent.click(screen.getByRole("button", { name: "Set and Commit" }));
  await expect(done).resolves.toBe(true);
  expect(git.set).toHaveBeenCalledWith(null, "Ann", "ann@example.com", true);
});

it("sets it in each repository without one when not global, proposing the others' identity", async () => {
  configure("/p/a", "Ann", "ann@example.com");
  render(<VcsDialogHost />);
  let done!: Promise<boolean>;
  act(() => void (done = ensureCommitIdentity(["/p/a", "/p/b", "/p/c"], true)));
  expect(((await screen.findByLabelText("Name:")) as HTMLInputElement).value).toBe("Ann");
  expect((screen.getByLabelText("E-mail:") as HTMLInputElement).value).toBe("ann@example.com");
  expect(screen.getByText(/not defined in 2 roots/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Set properties globally" }));
  fireEvent.click(screen.getByRole("button", { name: "Set and Amend Commit" }));
  await expect(done).resolves.toBe(true);
  expect(git.set.mock.calls).toEqual([
    ["/p/b", "Ann", "ann@example.com", false],
    ["/p/c", "Ann", "ann@example.com", false],
  ]);
});

it("does not commit when the dialog is cancelled", async () => {
  render(<VcsDialogHost />);
  let done!: Promise<boolean>;
  act(() => void (done = ensureCommitIdentity([null], false)));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await expect(done).resolves.toBe(false);
  await waitFor(() => expect(screen.queryByLabelText("Name:")).toBeNull());
  expect(git.set).not.toHaveBeenCalled();
});

it("validates the identity", () => {
  expect(identityError(" ", "a@b")).toBe("You need to specify username and email for Git");
  expect(identityError("Ann", "ann")).toBe("The email address must contain the '@' symbol");
  expect(identityError("Ann", "ann@example.com")).toBeNull();
});
