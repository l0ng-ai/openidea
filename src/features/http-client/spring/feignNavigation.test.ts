import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _emitEditorEvent } from "@/editor/api";
import { commands, emitLocalIdeEvent, type ProjectInfo } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { controllerMethods, feignMethods } from "./feign";
import { feignClients, feignTargets, registerFeignNavigation } from "./feignNavigation";

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

  it("keeps the disk index while a controller is edited", async () => {
    await resolve();
    for (let version = 2; version < 6; version++) {
      _emitEditorEvent({ type: "docChanged", doc: 9, path: users, baseVersion: version - 1, version, changes: [] });
      await resolve();
    }
    expect(commands.springRouteSources).toHaveBeenCalledTimes(1);
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

describe("finding Feign declarations from a controller", () => {
  const clients = (controller = server, source = users) => feignClients(source, controllerMethods(controller)[0]!);
  const config = "/p/users/src/main/resources/application.properties";

  it("orders service matches first, excludes other services and returns each declaration at its UTF-16 identifier", async () => {
    const unknown = "/p/a/src/main/java/Dynamic.java";
    const direct = "/p/b/src/main/java/Direct.java";
    const source = client.replace(
      '@GetMapping("/users/{id}")',
      '@GetMapping({"/users/{key}", "/users/{id}"}) /* 🛒 */',
    );
    files.set(clientPath, source);
    files.set(unknown, client.replace('name="users"', 'name="${service}"'));
    files.set(direct, client.replace('name="users"', 'name="elsewhere",url="https://example.org"'));
    files.set("/p/z/src/main/java/Other.java", client.replace('name="users"', 'name="admin"'));
    files.set("/p/admin/src/main/java/OtherVerb.java", client.replaceAll("GetMapping", "PostMapping"));
    files.set("/p/admin/src/main/java/OtherPath.java", client.replace("/users/{id}", "/users/all/active"));
    await resolve(); // Both lookups share the same inventory.
    const results = await clients();
    expect(results.map((t) => [t.path, !!t.possible])).toEqual([
      [clientPath, false],
      [unknown, true],
      [direct, true],
    ]);
    const col = source.split("\n")[2]!.indexOf("find()");
    expect(results[0]).toMatchObject({
      name: "Client.find",
      range: { start: { line: 2, col }, end: { line: 2, col: col + 4 } },
    });
    expect(commands.springRouteSources).toHaveBeenCalledTimes(1);
  });

  it("keeps the roles of client and server for HEAD and unconstrained mappings", async () => {
    files.set(
      clientPath,
      client
        .replace(
          "import org.springframework.web.bind.annotation.GetMapping",
          "import org.springframework.web.bind.annotation.*",
        )
        .replace('@GetMapping("/users/{id}")', '@RequestMapping(path="/users/{id}", method=RequestMethod.HEAD)'),
    );
    const post = "/p/client/src/main/java/Post.java";
    files.set(post, client.replaceAll("GetMapping", "PostMapping"));
    expect((await clients()).map((t) => t.path)).toEqual([clientPath]);
    expect((await clients(server.replace("GetMapping", "RequestMapping"))).map((t) => t.path)).toEqual([
      clientPath,
      post,
    ]);
    expect(await clients(server.replace("GetMapping", "PutMapping"))).toEqual([]);
  });

  it("rechecks edited and deleted declarations and the controller's current service without rescanning on typing", async () => {
    const edit = (path: string) =>
      _emitEditorEvent({ type: "docChanged", doc: 9, path, baseVersion: 1, version: 2, changes: [] });
    files.set(clientPath, client);
    expect((await clients()).map((t) => t.name)).toEqual(["Client.find"]);
    files.set(clientPath, client.replace('name="users"', 'name="admin"'));
    expect(await clients()).toEqual([]); // Revalidate even when the source event has not arrived yet.
    const added = "/p/orders/src/main/kotlin/New.kt";
    files.set(
      added,
      `import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.GetMapping
@FeignClient("users")
interface New { @GetMapping("/users/{key}") fun lookup(): String }`,
    );
    edit(added); // Newly edited, without a visible editor or an entry in the disk index.
    expect((await clients()).map((t) => t.name)).toEqual(["New.lookup"]);
    files.set(config, "spring.application.name=admin\n");
    edit(config);
    edit(clientPath);
    expect((await clients()).map((t) => t.name)).toEqual(["Client.find"]);
    files.delete(clientPath);
    expect(await clients()).toEqual([]);
    expect(commands.springRouteSources).toHaveBeenCalledTimes(1);
  });

  it("marks every match as possible if the controller's owning module has no unique identity", async () => {
    files.set(clientPath, client);
    files.set("/p/src/main/resources/application.properties", "spring.application.name=users\n");
    files.set("/p/users/src/main/resources/application-live.yml", "spring.application.name: alternate\n");
    files.set("/outside/src/main/java/Other.java", client);
    expect((await clients()).map((t) => [t.path, t.possible])).toEqual([[clientPath, true]]);
    expect(vi.mocked(commands.fsReadText).mock.calls.every(([path]) => path.startsWith("/p/"))).toBe(true);
  });

  it("finds a Java client for a Kotlin endpoint across linked projects and ignores unattached siblings", async () => {
    const kotlin = `import org.springframework.web.bind.annotation.*
@RestController class Users { @GetMapping("/users/{user}") fun find(): String = "" }`;
    const source = "/p/users/src/main/kotlin/Users.kt";
    useProject.setState({
      project: {
        ...project("/workspace"),
        workspace: {
          version: 1,
          name: "Services",
          projects: ["/p/users", "/p/client"],
        },
      },
    });
    files.set(source, kotlin);
    files.set(clientPath, client);
    files.set("/p/unattached/src/main/java/Other.java", client);
    expect((await clients(kotlin, source)).map((t) => [t.path, !!t.possible])).toEqual([[clientPath, false]]);
    expect(commands.fsReadText).not.toHaveBeenCalledWith("/p/unattached/src/main/java/Other.java");
  });

  it("skips untrusted and outside sources, and cancels a pending lookup on workspace switch", async () => {
    useProject.setState({ project: { ...project(), trusted: false } });
    expect(await clients()).toEqual([]);
    useProject.setState({ project: project() });
    expect(await clients(server, "/elsewhere/Users.java")).toEqual([]);
    expect(commands.springRouteSources).not.toHaveBeenCalled();
    expect(commands.fsReadDir).not.toHaveBeenCalled();
    let finish!: (value: Awaited<ReturnType<typeof commands.springRouteSources>>) => void;
    vi.mocked(commands.springRouteSources).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = clients();
    useProject.setState({ project: project("/elsewhere") });
    finish({ status: "ok", data: [{ path: clientPath, text: client }] });
    expect(await pending).toEqual([]);
    expect(commands.fsReadText).not.toHaveBeenCalledWith(clientPath);
  });
});
