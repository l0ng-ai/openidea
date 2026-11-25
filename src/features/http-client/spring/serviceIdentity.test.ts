import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@/platform/ipc";
import { loadServiceName, sourceModule, type ServiceReader } from "./serviceIdentity";

function reader(configs: Record<string, string>, override?: Partial<FileEntry>): ServiceReader {
  const folder = (path: string): FileEntry => ({
    path,
    name: path.split("/").at(-1)!,
    kind: "dir",
    size: 0,
    mtimeMs: 0,
    ignored: false,
    excluded: false,
    hidden: false,
  });
  return {
    directory: async (path) =>
      path.endsWith("/main")
        ? [folder(`${path}/resources`)]
        : [
            ...(path.endsWith("/resources") && Object.keys(configs).some((key) => key.startsWith("config/"))
              ? [folder(`${path}/config`)]
              : []),
            ...Object.entries(configs)
              .filter(([name]) => path.endsWith("/config") === name.startsWith("config/"))
              .map(([name, text]): FileEntry => {
                name = name.replace(/^config\//, "");
                return {
                  path: `${path}/${name}`,
                  name,
                  kind: "file",
                  size: text.length,
                  mtimeMs: 0,
                  ignored: false,
                  excluded: false,
                  hidden: false,
                  ...override,
                };
              }),
          ],
    read: async (path) => configs[path.split("/src/main/resources/")[1]!]!,
  };
}

describe("source-declared Spring service identity", () => {
  it("reads properties/YAML in the exact module, including resources/config", async () => {
    for (const configs of [
      { "application.properties": "spring.application.name=users\n" },
      { "application.yml": "spring:\n  application:\n    name: 'users' # local\n" },
      { "config/application.yaml": "spring.application.name: users\n" },
      {
        "application.properties": "spring.application.name=users\n",
        "application-dev.properties": "spring.application.name=users\n",
      },
    ] as Record<string, string>[])
      expect(await loadServiceName("/p/users", reader(configs))).toBe("users");
    expect(sourceModule("D:\\p\\users\\src\\main\\kotlin\\Users.kt")).toBe("D:/p/users");
    expect(sourceModule("/p/users/child/src/main/java/C.java")).toBe("/p/users/child");
    expect(sourceModule("/p/users/src/test/java/C.java")).toBeNull();
    expect(sourceModule("/p/users/src/other/C.java")).toBeNull();
  });

  it("withholds identity for unknown, conflicting, profile-only and unsupported configuration", async () => {
    const samples: Record<string, string>[] = [
      {},
      { "application.yaml": "description: |\n  spring.application.name: fake\n" },
      { "application-dev.properties": "spring.application.name=users\n" },
      { "application.properties": "spring.application.name=${SERVICE:users}\n" },
      { "application.properties": "spring.application.name=users\nspring.application.name=admin\n" },
      {
        "application.properties": "spring.application.name=users\n",
        "application-dev.yaml": "spring.application.name: admin\n",
      },
      { "application.yaml": "spring.application.name: users\n---\nspring.application.name: admin\n" },
      { "application.yaml": "spring.application.name: users\nspring.config.activate.on-profile: dev\n" },
      { "application.properties": "spring.application.name=users\nspring.config.import=optional:configserver:\n" },
      {
        "application.properties": "spring.application.name=users\n",
        "application-dev.yaml": "spring: {application: {name: admin}}\n",
      },
      {
        "application.properties": "spring.application.name=users\n",
        "application-dev.yaml": "{spring.application.name: admin}\n",
      },
      {
        "application.properties": "spring.application.name=users\n",
        "application-dev.yaml": "spring.config: {import: 'optional:configserver:'}\n",
      },
      {
        "application.properties": "spring.application.name=users\n",
        "application-dev.yaml": "!custom {spring.application.name: admin}\n",
      },
      {
        "application.properties": "spring.application.name=users\n",
        "application-dev.properties": "spring.application.\\u006eame=admin\n",
      },
      {
        "application.properties": "spring.application.name=users\n",
        "application-dev.yaml": '"spring.application.\\u006eame": admin\n',
      },
      {
        "application.properties": "spring.application.name=users\n",
        "bootstrap.yaml": "spring.application.name: admin\n",
      },
    ];
    for (const configs of samples)
      expect(await loadServiceName("/p/users", reader(configs)), JSON.stringify(configs)).toBeNull();
  });

  it("does not follow symlinks, read excluded configs, or trust capped/unreadable inventories", async () => {
    const configs = { "application.properties": "spring.application.name=users\n" };
    for (const override of [
      { kind: "symlink" },
      { excluded: true },
      { ignored: true },
      { size: 200_000 },
      { path: "/outside/application.properties" },
    ] as Partial<FileEntry>[]) {
      const r = reader(configs, override);
      r.read = async () => {
        throw new Error("Must not be read");
      };
      expect(await loadServiceName("/p/users", r)).toBeNull();
    }
    const denied = reader(configs);
    denied.directory = async () => {
      throw { kind: "permissionDenied" };
    };
    expect(await loadServiceName("/p/users", denied)).toBeNull();
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`application-${i}.properties`, "spring.application.name=users\n"]),
    );
    expect(await loadServiceName("/p/users", reader({ ...configs, ...many }))).toBeNull();
    for (const entry of [{ kind: "symlink" }, { excluded: true }, { ignored: true }]) {
      const r = reader(configs);
      const list = r.directory;
      r.directory = vi.fn(async (path) => (await list(path)).map((file) => ({ ...file, ...entry }) as FileEntry));
      r.read = vi.fn();
      expect(await loadServiceName("/p/users", r)).toBeNull();
      expect(r.directory).toHaveBeenCalledTimes(1);
      expect(r.read).not.toHaveBeenCalled();
    }
  });
});
