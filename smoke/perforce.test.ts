/**
 * A project in a Perforce workspace the way the Commit tool window sees it: the VCS
 * store finds the workspace, the changelist store mirrors the server's pending
 * changelists and sends edits to it, and a commit submits. Runs against a throwaway
 * server (`p4d` through `rsh:`); skipped without `p4` and `p4d` (`$P4D`, else on PATH).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commands } from "@/bindings";
import { call } from "@/platform/ipc";
import { openProject, useProject } from "@/platform/project";
import {
  addList,
  DEFAULT_LIST_ID,
  editList,
  installChangelists,
  moveFiles,
  removeList,
  updateChangelists,
  useChangelists,
} from "@/features/vcs/changelists";
import { installVcsStore, refreshNow, useVcs } from "@/features/vcs/store";
import { connectDesktop } from "./desktop";
import { Server } from "./server";

function onPath(name: string): string | undefined {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find((file) => existsSync(file));
}

const p4d = process.env.P4D && existsSync(process.env.P4D) ? process.env.P4D : onPath("p4d");
const available = !!p4d && !!onPath("p4");

let server: Server | null = null;
let cleanup: (() => void)[] = [];
let base = "";

afterEach(async () => {
  cleanup.reverse().forEach((f) => f());
  cleanup = [];
  await server?.close();
  if (base) {
    // Synced files are read-only.
    execFileSync("chmod", ["-R", "u+w", base]);
    rmSync(base, { recursive: true, force: true });
  }
});

async function until(what: string, done: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop -- polls until the condition holds
    await new Promise((r) => setTimeout(r, 50));
  }
}

test.skipIf(!available)("changelists and submit in a Perforce workspace", async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "openidea-p4-")));
  const root = join(base, "ws");
  mkdirSync(join(base, "depot"));
  mkdirSync(root);
  const port = `rsh:${p4d} -r ${join(base, "depot")} -L ${join(base, "log")} -i`;
  writeFileSync(join(root, ".p4config"), `P4PORT=${port}\nP4USER=ann\nP4CLIENT=ws\nP4CHARSET=none\n`);
  // Setup names the throwaway server itself; it must never reach a configured one.
  const p4 = (args: string[], input?: string) =>
    execFileSync("p4", ["-p", port, "-u", "ann", "-c", "ws", "-C", "none", ...args], {
      cwd: root,
      env: { ...process.env, PWD: root, P4CONFIG: ".p4config" },
      input,
      encoding: "utf8",
    });
  p4(["client", "-i"], p4(["client", "-o"]));
  const a = join(root, "a.txt");
  const b = join(root, "b.txt");
  writeFileSync(a, "one\n");
  writeFileSync(b, "two\n");

  server = await Server.start(join(base, "home"), { P4CONFIG: ".p4config" });
  cleanup.push(connectDesktop(server), installVcsStore(), installChangelists());
  await openProject(root);
  await call(commands.projectTrustSet(root, true, false));
  useProject.setState({ project: { ...useProject.getState().project!, trusted: true } });

  await until("the Perforce workspace", () => useVcs.getState().kinds[root] === "perforce");
  const workspaces = await call(commands.p4Workspaces());
  expect(workspaces.map((w) => [w.root, w.connection.client])).toEqual([[root, "ws"]]);
  expect(useVcs.getState().branch?.head).toBe("ws");

  await call(commands.vcsStage([a, b]));
  await refreshNow();
  expect(useVcs.getState().status.map((f) => [f.relPath, f.unstaged])).toEqual([
    ["a.txt", "added"],
    ["b.txt", "added"],
  ]);
  const lists = () => useChangelists.getState().state;
  await until("the default changelist's files", () => lists().files?.["a.txt"] === DEFAULT_LIST_ID);
  expect(lists().lists.map((l) => l.name)).toEqual(["Default"]);

  // New Changelist with a file moved into it: a numbered pending changelist on the server.
  updateChangelists((s) => {
    const made = addList(s, "feature", { comment: "more detail", makeActive: true });
    return moveFiles(made.state, ["a.txt"], made.id);
  });
  await until("the new changelist", () => lists().lists.length === 2 && lists().files?.["a.txt"] !== DEFAULT_LIST_ID);
  const feature = lists().lists[1]!;
  expect(feature).toMatchObject({ name: "feature", comment: "more detail" });
  expect(Number(feature.id)).toBeGreaterThan(0);
  expect(lists().active).toBe(feature.id);
  expect(lists().files).toEqual({ "a.txt": feature.id, "b.txt": DEFAULT_LIST_ID });

  updateChangelists((s) => editList(s, feature.id, "feature renamed", ""));
  await until("the new description", () => lists().lists[1]?.name === "feature renamed");
  const pending = await call(commands.p4Changelists(root));
  expect(pending.map((c) => [c.number, c.description, c.files.length])).toEqual([
    [0, "", 1],
    [Number(feature.id), "feature renamed", 1],
  ]);

  // Commit of the list's only file submits that changelist under the commit message.
  const submitted = await call(
    commands.vcsCommit(root, "add a", {
      amend: false,
      signOff: false,
      author: null,
      runHooks: true,
      partial: [],
      stage: [a],
      exclude: [],
    }),
  );
  await refreshNow();
  await until("the submitted changelist to leave", () => lists().lists.length === 1);
  expect(useVcs.getState().status.map((f) => f.relPath)).toEqual(["b.txt"]);
  expect(lists().active).toBe(DEFAULT_LIST_ID);
  const log = await call(
    commands.vcsLog(root, { branch: null, path: null, author: null, text: null, skip: 0, limit: 5 }),
  );
  expect(log.map((c) => [c.id, c.summary])).toEqual([[submitted, "add a"]]);

  // A synced file is read-only; making it writable opens it for edit.
  expect(statSync(a).mode & 0o200).toBe(0);
  expect(await call(commands.fsSetWritable(a, true))).toBe(false);
  expect(statSync(a).mode & 0o200).not.toBe(0);
  writeFileSync(a, "one\nmore\n");
  await refreshNow();
  expect(useVcs.getState().byPath.get(a)?.unstaged).toBe("modified");
  expect(await call(commands.vcsDiffText(a, false))).toContain("+more");

  // Deleting a list moves its files to the active one and deletes the changelist.
  updateChangelists((s) => moveFiles(addList(s, "scratch").state, [], DEFAULT_LIST_ID));
  await until("a second list", () => lists().lists.length === 2);
  const scratch = lists().lists[1]!.id;
  updateChangelists((s) => moveFiles(s, ["b.txt"], scratch));
  await until("b.txt in it", () => lists().files?.["b.txt"] === scratch);
  updateChangelists((s) => removeList(s, scratch));
  await until("the list to be deleted", () => lists().lists.length === 1);
  expect(lists().files).toEqual({ "a.txt": DEFAULT_LIST_ID, "b.txt": DEFAULT_LIST_ID });

  const synced = await call(commands.p4Sync(root, [], null, false, false));
  expect(synced.files).toEqual([]);
  chmodSync(a, 0o644);
});
