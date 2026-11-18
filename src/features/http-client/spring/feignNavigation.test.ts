import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _emitEditorEvent } from "@/editor/api";
import { commands, emitLocalIdeEvent, type ProjectInfo } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { feignMethods } from "./feign";
import { feignTargets, registerFeignNavigation } from "./feignNavigation";

const root = "/p";
const clientPath = "/p/client/src/main/java/Client.java";
const client = `import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
@FeignClient(name="users") interface Client { @GetMapping("/users/{id}") String find(); }`;
const server = `import org.springframework.web.bind.annotation.*;
@RestController class Users { @GetMapping("/users/{userId}") String find() { return ""; } }`;
const users = "/p/users/src/main/java/Users.java";
const admin = "/p/admin/src/main/java/Users.java";
let files: Map<string, string>;
let dispose: () => void;

function project(path = root): ProjectInfo {
  return { root: path, name: "fixture", settings: {}, trusted: true, isGit: false };
}
const resolve = (text = client) => feignTargets(clientPath, feignMethods(text)[0]!);

beforeEach(() => {
  files = new Map([
    [users, server],
    [admin, server],
    ["/p/users/src/main/resources/application.properties", "spring.application.name=users\n"],
    ["/p/admin/src/main/resources/application.yaml", "spring.application.name: admin\n"],
  ]);
  useProject.setState({ project: project() });
  vi.spyOn(commands, "springRouteSources").mockImplementation(async () => ({
    status: "ok",
    data: [...files].filter(([p]) => p.endsWith(".java") || p.endsWith(".kt")).map(([path, text]) => ({ path, text })),
  }));
  vi.spyOn(commands, "fsReadText").mockImplementation(async (path) =>
    files.has(path)
      ? { status: "ok", data: files.get(path)! }
      : { status: "error", error: { kind: "notFound", message: "Fixture file missing", detail: null } },
  );
  vi.spyOn(commands, "fsReadDir").mockImplementation(async (path) => ({
    status: "ok",
    data: [
      ...new Set(
        [...files.keys()].filter((p) => p.startsWith(`${path}/`)).map((p) => p.slice(path.length + 1).split("/")[0]!),
      ),
    ].map((name) => ({
      path: `${path}/${name}`,
      name,
      kind: files.has(`${path}/${name}`) ? "file" : "dir",
      size: files.get(`${path}/${name}`)?.length ?? 0,
      mtimeMs: 0,
      ignored: false,
      excluded: false,
      hidden: false,
    })),
  }));
  dispose = registerFeignNavigation();
});
afterEach(() => {
  dispose();
  vi.restoreAllMocks();
  useProject.setState({ project: null });
});

describe("core service-aware Feign navigation", () => {
  it("selects the correct service despite identical paths, and caches the project/configuration inventory", async () => {
    expect((await resolve()).map((t) => t.path)).toEqual([users]);
    expect((await resolve()).map((t) => t.path)).toEqual([users]);
    expect(commands.springRouteSources).toHaveBeenCalledTimes(1);
    expect(commands.fsReadDir).toHaveBeenCalledTimes(4);
    expect((await resolve())[0]?.range).toEqual({
      start: { line: 1, col: server.split("\n")[1]!.indexOf("find()") },
      end: { line: 1, col: server.split("\n")[1]!.indexOf("find()") + 4 },
    });
  });

  it("returns every candidate for unknown identities and explicit URLs", async () => {
    expect((await resolve(client.replace('name="users"', 'name="${service}"'))).map((t) => t.path)).toEqual([
      admin,
      users,
    ]);
    expect(
      (await resolve(client.replace('name="users"', 'name="users",url="https://api.example"'))).map((t) => t.path),
    ).toEqual([admin, users]);
    files.delete("/p/admin/src/main/resources/application.yaml");
    expect((await resolve()).map((t) => t.path)).toEqual([admin, users]);
  });

  it("refreshes identities and targets after configuration and source filesystem events", async () => {
    expect((await resolve()).map((t) => t.path)).toEqual([users]);
    const config = "/p/admin/src/main/resources/application.yaml";
    files.set(config, "spring.application.name: users\n");
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [config], removed: [] });
    expect((await resolve()).map((t) => t.path)).toEqual([admin, users]);
    files.set(users, server.replace("/users/{userId}", "/elsewhere"));
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [users], removed: [] });
    expect((await resolve()).map((t) => t.path)).toEqual([admin]);
    files.delete(admin);
    expect(await resolve()).toEqual([]); // Current source revalidation rejects the cached target.
  });

  it("overlays recently edited unsaved controllers absent from the disk index", async () => {
    await resolve();
    const path = "/p/users/src/main/kotlin/Added.kt";
    const text = `import org.springframework.web.bind.annotation.*\n@RestController class Added { @GetMapping("/users/{id}") fun added(): String = "" }`;
    files.set(path, text);
    vi.mocked(commands.springRouteSources).mockResolvedValue({
      status: "ok",
      data: [
        { path: users, text: server },
        { path: admin, text: server },
      ],
    });
    _emitEditorEvent({ type: "docChanged", doc: 9, path, baseVersion: 1, version: 2, changes: [] });
    expect((await resolve()).map((t) => t.path)).toEqual([users, path]);
  });

  it("does not inherit parent module identities or leave the open project", async () => {
    files.set("/p/src/main/resources/application.properties", "spring.application.name=admin\n");
    files.set("/p/users/child/src/main/java/Child.java", server);
    files.set("/outside/src/main/java/Other.java", server);
    expect((await resolve()).map((t) => t.path)).toEqual(["/p/users/child/src/main/java/Child.java", users]);
    useProject.setState({ project: { ...project(), trusted: false } });
    expect(await resolve()).toEqual([]);
  });

  it("discards a delayed result after a project switch and retries a failed inventory", async () => {
    let finish!: (result: Awaited<ReturnType<typeof commands.springRouteSources>>) => void;
    vi.mocked(commands.springRouteSources).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = resolve();
    useProject.setState({ project: project("/other") });
    finish({ status: "ok", data: [{ path: users, text: server }] });
    expect(await pending).toEqual([]);
    useProject.setState({ project: project() });
    vi.mocked(commands.springRouteSources).mockRejectedValueOnce(new Error("temporarily unavailable"));
    await expect(resolve()).rejects.toThrow("temporarily unavailable");
    expect((await resolve()).map((t) => t.path)).toEqual([users]);
  });

  it("keeps service configuration reads inside the controller's owning project member", async () => {
    useProject.setState({
      project: {
        ...project("/workspace"),
        workspace: {
          version: 1,
          name: "Sources only",
          projects: ["/p/client/src/main/java", "/p/users/src/main/java", "/p/admin/src/main/java"],
        },
      },
    });
    expect((await resolve()).map((t) => t.path)).toEqual([admin, users]);
    expect(commands.fsReadDir).not.toHaveBeenCalled();
    expect(vi.mocked(commands.fsReadText).mock.calls.every(([path]) => path.endsWith(".java"))).toBe(true);
  });
});
