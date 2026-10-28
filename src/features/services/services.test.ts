import { describe, expect, it } from "vitest";
import type { DockerContainer, DockerSnapshot } from "@/platform/ipc";
import { composeTargets, dockerfileTargets, fileTargets, imageTag, isComposeFile, isDockerfile } from "./compose";
import {
  DOCKERFILE,
  DOCKER_COMPOSE,
  containerName,
  dockerComposeType,
  dockerImageType,
  gutterActions,
  shellQuote,
} from "./runTypes";
import {
  childrenOf,
  findNode,
  nodeDetail,
  nodeLabel,
  parseTreeKey,
  rootNodes,
  treeKey,
  type ServiceNode,
} from "./model";
import { endpointFrom } from "./dialogs";
import { dockerItems } from "./docker";
import { addServiceMenu, expandableKeys, indexTree, setProviderRoots, useServicesTree } from "./tree";

const container = (name: string, state: string, project?: string, service?: string): DockerContainer => ({
  id: `${name}-id`,
  name,
  image: "img",
  command: "",
  state,
  status: state === "running" ? "Up 1 hour" : "Exited (0)",
  ports: "",
  createdAt: "",
  composeProject: project ?? null,
  composeService: service ?? null,
  composeWorkingDir: null,
  composeFiles: [],
});

const snapshot: DockerSnapshot = {
  availability: { kind: "ready", clientVersion: "27", serverVersion: "27", context: null },
  executable: "/usr/bin/docker",
  containers: [
    container("web", "exited"),
    container("shop-db-1", "running", "shop", "db"),
    container("shop-api-1", "exited", "shop", "api"),
  ],
  images: [{ id: "sha256:abc", repository: "postgres", tag: "16", size: "1MB", createdSince: "now" }],
  volumes: [],
  networks: [],
  errors: [],
};

describe("services tree", () => {
  it("groups containers by compose project before standalone ones", () => {
    const children = childrenOf(snapshot);
    const [docker] = rootNodes();
    const groups = children(docker!)!;
    expect(groups.map(nodeLabel)).toEqual(["Containers", "Images", "Volumes", "Networks"]);
    expect(nodeDetail(groups[0]!)).toBe("3");
    const containers = children(groups[0]!)!;
    expect(containers.map((n) => n.kind)).toEqual(["compose", "container"]);
    const shop = containers[0] as Extract<ServiceNode, { kind: "compose" }>;
    expect(nodeDetail(shop)).toBe("1/2 running");
    expect(children(shop)!.map(nodeLabel)).toEqual(["api", "db"]);
    expect(nodeLabel(children(groups[1]!)![0]!)).toBe("postgres:16");
  });

  it("finds nodes again in a new snapshot", () => {
    expect(findNode(snapshot, "container:shop-db-1-id")?.kind).toBe("container");
    expect(findNode(snapshot, "container:gone")).toBeNull();
  });

  it("has no children while docker is down", () => {
    const down: DockerSnapshot = { ...snapshot, availability: { kind: "daemonDown", message: "x", context: null } };
    expect(childrenOf(down)(rootNodes()[0]!)).toBeUndefined();
  });
});

describe("services tree host", () => {
  const conns = [
    { id: "default", name: "Docker", endpoint: { kind: "default" as const } },
    { id: "c2", name: "Build box", endpoint: { kind: "tcp" as const, host: "build:2376", tlsCertDir: null } },
  ];
  const state = { default: { snapshot, loading: false, error: null } };

  it("puts every connection and registry at the root, with connection-scoped keys", () => {
    const items = dockerItems(conns, [{ id: "r1", name: "GHCR", address: "ghcr.io", username: "me" }], state);
    expect(items.map((i) => [i.key, i.label, i.detail])).toEqual([
      ["docker:default", "Docker", undefined],
      ["docker:c2", "Build box", undefined],
      ["docker-registry:r1", "GHCR", "ghcr.io"],
    ]);
    expect(items[1]!.dim).toBe(true);
    expect(items[1]!.children).toEqual([]);
    const containers = items[0]!.children![0]!;
    expect(containers.key).toBe("docker:default:group:containers");
    expect(containers.children!.map((c) => c.key)).toEqual([
      "docker:default:compose:shop",
      "docker:default:container:web-id",
    ]);
    expect(containers.children![1]!.dim).toBe(true);
    const index = indexTree({ docker: items });
    expect(index.get("docker:default:container:shop-db-1-id")?.item.label).toBe("db");
    expect(expandableKeys(items)).toContain("docker:default:compose:shop");
  });

  it("round-trips tree keys", () => {
    const node = findNode(snapshot, "container:web-id")!;
    expect(treeKey("c2", node)).toBe("docker:c2:container:web-id");
    expect(parseTreeKey("docker:c2:container:web-id")).toEqual({ conn: "c2", local: "container:web-id" });
    expect(parseTreeKey("docker:c2")).toEqual({ conn: "c2", local: "docker" });
    expect(treeKey("c2", rootNodes()[0]!)).toBe("docker:c2");
    expect(parseTreeKey("run:type:cargo")).toBeNull();
  });

  it("joins the providers' Add Service entries", () => {
    const providers = [
      { id: "a", useRoots: () => [], addMenu: () => [{ label: "Run Configuration Type" }] },
      { id: "b", useRoots: () => [] },
      { id: "c", useRoots: () => [], addMenu: () => [{ label: "Docker Registry…" }, { label: "Docker Connection…" }] },
    ];
    expect(addServiceMenu(providers).map((m) => ("label" in m ? m.label : m.kind))).toEqual([
      "Run Configuration Type",
      "separator",
      "Docker Registry…",
      "Docker Connection…",
    ]);
  });

  it("expands nodes asking for it once, when they first appear", () => {
    const group = () => ({ key: "run:type:npm", label: "npm", icon: "x", expanded: true, children: [] });
    setProviderRoots("run", [group()]);
    expect(useServicesTree.getState().expanded.has("run:type:npm")).toBe(true);
    useServicesTree.setState({ expanded: new Set() });
    setProviderRoots("run", [group()]);
    expect(useServicesTree.getState().expanded.has("run:type:npm")).toBe(false);
  });

  it("builds connection endpoints from the dialog fields", () => {
    const f = { path: " /var/run/docker.sock ", host: "", tls: "", context: "" };
    expect(endpointFrom("socket", f)).toEqual({ kind: "socket", path: "/var/run/docker.sock" });
    expect(endpointFrom("tcp", f)).toBeNull();
    expect(endpointFrom("tcp", { ...f, host: "tcp://h:2376", tls: "/certs" })).toEqual({
      kind: "tcp",
      host: "tcp://h:2376",
      tlsCertDir: "/certs",
    });
    expect(endpointFrom("tcp", { ...f, host: "h:2375", tls: " " })).toEqual({
      kind: "tcp",
      host: "h:2375",
      tlsCertDir: null,
    });
    expect(endpointFrom("context", { ...f, context: "--evil" })).toBeNull();
    expect(endpointFrom("context", { ...f, context: "orbstack" })).toEqual({ kind: "context", name: "orbstack" });
    expect(endpointFrom("default", f)).toEqual({ kind: "default" });
  });
});

describe("docker run targets", () => {
  it("recognises file names", () => {
    expect(isDockerfile("/p/Dockerfile")).toBe(true);
    expect(isDockerfile("/p/Dockerfile.dev")).toBe(true);
    expect(isDockerfile("/p/api.dockerfile")).toBe(true);
    expect(isDockerfile("/p/Dockerfiles.md")).toBe(false);
    expect(isComposeFile("/p/docker-compose.yml")).toBe(true);
    expect(isComposeFile("/p/compose.override.yaml")).toBe(true);
    expect(isComposeFile("/p/values.yaml")).toBe(false);
  });

  it("finds compose services directly under services:", () => {
    const text = [
      "name: shop",
      "services:",
      "  # the database",
      "  db:",
      "    image: postgres:16",
      "    environment:",
      "      POSTGRES_PASSWORD: x",
      '  "api":',
      "    build: .",
      "    depends_on:",
      "      - db",
      "volumes:",
      "  pgdata:",
    ].join("\n");
    expect(composeTargets(text)).toEqual([
      { kind: "composeAll", line: 1 },
      { kind: "composeService", line: 3, service: "db" },
      { kind: "composeService", line: 7, service: "api" },
    ]);
    expect(composeTargets("version: '3'\n")).toEqual([]);
  });

  it("builds each FROM stage", () => {
    const text =
      "FROM node:22 AS build\nRUN npm ci\nFROM --platform=linux/amd64 nginx:1.27\nCOPY --from=build /app /usr/share/nginx/html\n";
    expect(dockerfileTargets(text)).toEqual([
      { kind: "build", line: 0, stage: "build", last: false },
      { kind: "build", line: 2, stage: null, last: true },
    ]);
    expect(fileTargets("/p/README.md", text)).toEqual([]);
  });

  it("creates Dockerfile and Docker Compose run configurations", () => {
    expect(imageTag("/work/My App/Dockerfile")).toBe("my-app:latest");
    const [stage] = gutterActions(
      { kind: "build", line: 0, stage: "build", last: false },
      "/work/app/docker/Dockerfile",
      "/work/app",
    );
    expect(stage!.title).toBe("Build Stage 'build'");
    expect(stage!.config).toMatchObject({
      kind: DOCKERFILE,
      cwd: null,
      params: { dockerfile: "docker/Dockerfile", target: "build" },
    });
    expect(stage!.config.command).toBe("docker build -f docker/Dockerfile -t docker:latest --target build docker");
    expect(stage!.config.stopCommand).toBeUndefined();

    const [run, buildOnly] = gutterActions(
      { kind: "build", line: 4, stage: null, last: true },
      "/work/app/Dockerfile",
      "/work/app",
    );
    expect(run!.title).toBe("Run 'Dockerfile'");
    expect(run!.config.command).toBe(
      "docker build -f Dockerfile -t app:latest . && (docker rm -f app >/dev/null 2>&1; docker run --name app app:latest)",
    );
    expect(run!.config.stopCommand).toBe("docker stop app");
    expect(buildOnly!.title).toBe("Build Image 'app:latest'");

    const [up] = gutterActions(
      { kind: "composeService", line: 3, service: "db" },
      "/work/app/compose.yaml",
      "/work/app",
    );
    expect(up!.config).toMatchObject({
      id: "docker:compose:compose.yaml:db",
      kind: DOCKER_COMPOSE,
      command: "docker compose -f compose.yaml up db",
      stopCommand: "docker compose -f compose.yaml down",
    });
  });

  it("builds container command lines from the form", () => {
    const image = dockerImageType.commandLine({
      image: "postgres:16",
      pull: "true",
      ports: "5432:5432, 9187:9187",
      volumes: "pg data:/var/lib/postgresql/data",
      containerEnv: "POSTGRES_PASSWORD=it's; A=b",
      runOptions: "--network host",
      command: "postgres -c fsync=off",
    })!;
    expect(image.command).toBe(
      "(docker rm -f postgres >/dev/null 2>&1; docker run --name postgres --pull always -p 5432:5432 -p 9187:9187 " +
        "-v 'pg data:/var/lib/postgresql/data' -e 'POSTGRES_PASSWORD=it'\\''s' -e A=b --network host postgres:16 postgres -c fsync=off)",
    );
    expect(image.stop).toBe("docker stop postgres");
    expect(containerName({ containerName: " web " }, "x")).toBe("web");
    expect(containerName({}, "ghcr.io/org/my-app@sha256:abc")).toBe("my-app");
    const detached = dockerComposeType.commandLine({
      files: "a.yml; b.yml",
      project: "demo",
      detach: "true",
      build: "true",
    })!;
    expect(detached).toMatchObject({ command: "docker compose -f a.yml -f b.yml -p demo up -d --build", stop: null });
    expect(shellQuote('a "b"', true)).toBe('"a ""b"""');
  });
});
