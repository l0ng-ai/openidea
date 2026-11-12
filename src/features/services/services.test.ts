import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DockerContainer, DockerSnapshot } from "@/platform/ipc";
import type { SshConfigValid } from "@/platform/remoteSettings";
import { fileIconName } from "@/ui/icons";
import {
  composeFileIcon,
  composeTargetAtLine,
  composeTargets,
  dockerfileTargets,
  fileTargets,
  imageTag,
  isAutoDetectedComposeFile,
  isComposeContent,
  isComposeFile,
  isDockerfile,
  useComposeFiles,
} from "./compose";
import { composeCompletionsAt, parseComposeDocument, resolveComposeReferenceAt } from "./composeEditor";
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
  containersInNetwork,
  containersUsingImage,
  containersUsingVolume,
  findImageForContainer,
  findNode,
  imageTagsForId,
  isUntaggedImage,
  nodeDetail,
  nodeIcon,
  nodeLabel,
  parseTreeKey,
  rootNodes,
  treeKey,
  type ServiceNode,
} from "./model";
import {
  bytesToUnits,
  formatCreatedDetailed,
  parseContainerInspect,
  parseImageInspect,
  parseNetworkInspect,
  parsePercent,
  parsePortMappings,
  parseUsagePair,
  splitLayerInstruction,
  unitsToBytes,
} from "./dashboard";
import { endpointFrom, sshConfigForUrl, sshConfigUrl } from "./dialogs";
import { dockerItems } from "./docker";
import { setDockerFilters, useServices } from "./store";
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
  it("groups compose projects at the top, followed by Dev Containers, Containers, Images, Networks and Volumes", () => {
    const children = childrenOf(snapshot);
    const [docker] = rootNodes();
    const groups = children(docker!)!;
    expect(groups.map(nodeLabel)).toEqual([
      "Docker-compose: shop",
      "Dev Containers",
      "Containers",
      "Images",
      "Networks",
      "Volumes",
    ]);
    expect(groups.map(nodeIcon)).toEqual([
      "docker-compose-running",
      "docker-devcontainer",
      "docker-containers",
      "docker-images",
      "docker-networks",
      "docker-volumes",
    ]);
    const shop = groups[0] as Extract<ServiceNode, { kind: "compose" }>;
    expect(nodeDetail(shop)).toBe("1/2 running");
    expect(children(shop)!.map(nodeLabel)).toEqual(["api", "db"]);
    expect(children(shop)!.map(nodeIcon)).toEqual(["docker-compose-service-stopped", "docker-compose-service-running"]);
    expect(nodeDetail(groups[2]!)).toBe("1");
    const containers = children(groups[2]!)!;
    expect(containers.map((n) => n.kind)).toEqual(["container"]);
    expect(nodeIcon(containers[0]!)).toBe("docker-container-stopped");
    expect(nodeLabel(children(groups[3]!)![0]!)).toBe("postgres:16");
    expect(nodeIcon(children(groups[3]!)![0]!)).toBe("docker-image");
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
    expect(items.map((i) => [i.key, i.label, i.detail, i.icon])).toEqual([
      ["docker:default", "Docker", undefined, "docker-connected"],
      ["docker:c2", "Build box", undefined, "file-docker"],
      ["docker-registry:r1", "GHCR", "ghcr.io", "docker-registry"],
    ]);
    expect(items[1]!.dim).toBe(true);
    expect(items[1]!.children).toEqual([]);
    const compose = items[0]!.children![0]!;
    expect(compose.key).toBe("docker:default:compose:shop");
    const containers = items[0]!.children![2]!;
    expect(containers.key).toBe("docker:default:group:containers");
    expect(containers.children!.map((c) => c.key)).toEqual(["docker:default:container:web-id"]);
    expect(containers.children![0]!.dim).toBe(true);
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

  it("fills the Engine API URL from an OpenSSH-config SSH configuration and shows the selection", () => {
    const box: SshConfigValid = {
      id: "ssh1",
      name: "Build server",
      host: "build-server",
      port: 2222,
      user: "ops",
      auth: "openSsh",
      keyFile: "",
      saveSecret: false,
    };
    const bare: SshConfigValid = { ...box, id: "ssh2", name: "", host: "bare", port: null, user: "", auth: "openSsh" };
    const password: SshConfigValid = { ...box, id: "ssh3", host: "vault", user: "root", port: null, auth: "password" };
    const configs = [box, bare, password];
    expect(sshConfigUrl(box)).toBe("ssh://ops@build-server:2222");
    expect(sshConfigUrl(bare)).toBe("ssh://bare");
    // The selection follows the URL the field holds; only OpenSSH-config configurations match.
    expect(sshConfigForUrl("ssh://ops@build-server:2222", configs)).toBe("ssh1");
    expect(sshConfigForUrl(" ssh://build-server:2222 ", configs)).toBe("ssh1");
    expect(sshConfigForUrl("ssh://build-server", configs)).toBe("ssh1");
    expect(sshConfigForUrl("ssh://bare", configs)).toBe("ssh2");
    // Another user or port than the configuration's, a tcp URL or a password configuration is not a selection.
    expect(sshConfigForUrl("ssh://root@build-server", configs)).toBe("");
    expect(sshConfigForUrl("ssh://build-server:22", configs)).toBe("");
    expect(sshConfigForUrl("ssh://root@vault", configs)).toBe("");
    expect(sshConfigForUrl("tcp://build-host:2376", configs)).toBe("");
    expect(sshConfigForUrl("ssh://", configs)).toBe("");
    expect(sshConfigForUrl("", configs)).toBe("");
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

describe("phase 1: filters, cross-references and dashboard parsers", () => {
  const richSnapshot: DockerSnapshot = {
    ...snapshot,
    containers: [
      {
        ...container("web", "exited"),
        image: "nginx:1.27",
        ports: "0.0.0.0:8080->80/tcp",
        mounts: [],
        networks: ["bridge"],
      },
      {
        ...container("shop-db-1", "running", "shop", "db"),
        image: "postgres:16",
        ports: "127.0.0.1:5432->5432/tcp",
        mounts: ["shop_pgdata"],
        networks: ["shop_default"],
      },
      {
        ...container("shop-api-1", "exited", "shop", "api"),
        image: "postgres:16",
        mounts: [],
        networks: ["shop_default"],
      },
    ],
    images: [
      { id: "sha256:1111111111112222", repository: "postgres", tag: "16", size: "431MB", createdSince: "7 weeks ago" },
      {
        id: "sha256:1111111111112222",
        repository: "postgres",
        tag: "latest",
        size: "431MB",
        createdSince: "7 weeks ago",
      },
      {
        id: "sha256:aaaaaaaaaaaa0000",
        repository: "<none>",
        tag: "<none>",
        size: "120MB",
        createdSince: "4 weeks ago",
      },
    ],
    volumes: [
      {
        name: "shop_pgdata",
        driver: "local",
        mountpoint: "/var/lib/docker/volumes/shop_pgdata/_data",
        composeProject: "shop",
      },
    ],
    networks: [{ id: "net-1", name: "shop_default", driver: "bridge", scope: "local", composeProject: "shop" }],
  };

  it("filters stopped containers and untagged images when toggled off", () => {
    const filtered = childrenOf(richSnapshot, { showStoppedContainers: false, showUntaggedImages: false });
    const [docker] = rootNodes();
    const groups = filtered(docker!)!;
    expect(groups.map(nodeLabel)).toEqual([
      "Docker-compose: shop",
      "Dev Containers",
      "Containers",
      "Images",
      "Networks",
      "Volumes",
    ]);
    const shopChildren = filtered(groups[0]!)!;
    expect(shopChildren.map(nodeLabel)).toEqual(["db"]);
    expect(nodeDetail(groups[2]!)).toBeUndefined();
    expect(nodeDetail(groups[3]!)).toBe("2");
    const imageNodes = filtered(groups[3]!)!;
    expect(imageNodes.map(nodeLabel)).toEqual(["postgres:16", "postgres:latest"]);
    expect(isUntaggedImage(richSnapshot.images[2]!)).toBe(true);
    expect(isUntaggedImage(richSnapshot.images[0]!)).toBe(false);

    setDockerFilters({ showStoppedContainers: false });
    expect(useServices.getState().filters.showStoppedContainers).toBe(false);
    setDockerFilters({ showStoppedContainers: true, showUntaggedImages: true });
  });

  it("cross-references images, volumes and networks with containers", () => {
    const pg = richSnapshot.images[0]!;
    expect(containersUsingImage(richSnapshot, pg).map((c) => c.name)).toEqual(["shop-db-1", "shop-api-1"]);
    expect(imageTagsForId(richSnapshot, pg)).toEqual(["postgres:16", "postgres:latest"]);
    expect(findImageForContainer(richSnapshot, richSnapshot.containers[1]!)?.id).toBe(pg.id);
    expect(containersUsingVolume(richSnapshot, richSnapshot.volumes[0]!).map((c) => c.name)).toEqual(["shop-db-1"]);
    expect(containersInNetwork(richSnapshot, richSnapshot.networks[0]!).map((c) => c.name)).toEqual([
      "shop-db-1",
      "shop-api-1",
    ]);
  });

  it("parses units, usage pairs, timestamps, ports, layers and inspect payloads", () => {
    expect(unitsToBytes("50MiB")).toBe(50 * 1024 * 1024);
    expect(unitsToBytes("431MB")).toBe(431 * 1000 * 1000);
    expect(bytesToUnits(50 * 1024 * 1024)).toBe("50.0 MiB");
    expect(parsePercent("12.5%")).toBe(12.5);
    const pair = parseUsagePair("512MiB / 2GiB");
    expect(pair.percent).toBeCloseTo(25, 1);

    const formatted = formatCreatedDetailed("2026-10-01T15:00:00Z", Date.parse("2026-10-03T17:00:00Z"), "UTC");
    expect(formatted).toContain("2d 2h ago");
    expect(formatted).toContain("2026-10-01 15:00:00");
    const localFormatted = formatCreatedDetailed("2026-10-01T15:00:00Z", Date.parse("2026-10-03T17:00:00Z"));
    expect(localFormatted).toContain("2d 2h ago");

    const ports = parsePortMappings("0.0.0.0:8080->80/tcp, 5432/tcp");
    expect(ports).toEqual([
      {
        hostIp: "0.0.0.0",
        hostPort: "8080",
        containerPort: "80",
        protocol: "tcp",
        url: "http://localhost:8080",
        label: "0.0.0.0:8080 -> 80/tcp",
      },
      {
        hostIp: "",
        hostPort: null,
        containerPort: "5432",
        protocol: "tcp",
        url: null,
        label: "5432/tcp",
      },
    ]);

    expect(splitLayerInstruction('/bin/sh -c #(nop)  CMD ["postgres"]')).toEqual({
      instruction: "CMD",
      args: '["postgres"]',
    });
    expect(splitLayerInstruction("RUN /bin/sh -c apt-get update # buildkit")).toEqual({
      instruction: "RUN",
      args: "/bin/sh -c apt-get update",
    });

    const cInspect = parseContainerInspect(
      JSON.stringify([
        {
          Created: "2026-10-01T15:00:00Z",
          Image: "sha256:1111",
          State: { Pid: 4321, ExitCode: 0, StartedAt: "2026-10-01T15:00:01Z", Health: { Status: "healthy" } },
          Config: {
            User: "postgres",
            WorkingDir: "/var/lib/postgresql",
            Entrypoint: ["docker-entrypoint.sh"],
            Cmd: ["postgres"],
            Env: ["POSTGRES_DB=shop", "PGDATA=/var/lib/postgresql/data"],
            Labels: { "com.docker.compose.project": "shop" },
          },
          HostConfig: { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } },
          Mounts: [
            {
              Type: "volume",
              Name: "shop_pgdata",
              Source: "/var/lib/docker/volumes/shop_pgdata/_data",
              Destination: "/var/lib/postgresql/data",
              Mode: "z",
              RW: true,
            },
          ],
          NetworkSettings: {
            Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5432" }] },
            Networks: { shop_default: { IPAddress: "172.18.0.2", Gateway: "172.18.0.1" } },
          },
        },
      ]),
    )!;
    expect(cInspect.pid).toBe(4321);
    expect(cInspect.healthStatus).toBe("healthy");
    expect(cInspect.restartPolicy).toBe("unless-stopped");
    expect(cInspect.env).toEqual([
      ["POSTGRES_DB", "shop"],
      ["PGDATA", "/var/lib/postgresql/data"],
    ]);
    expect(cInspect.mounts[0]!.name).toBe("shop_pgdata");
    expect(cInspect.ports[0]!.url).toBe("http://127.0.0.1:5432");
    expect(cInspect.networks[0]!.ipAddress).toBe("172.18.0.2");

    const iInspect = parseImageInspect(
      JSON.stringify({
        Created: "2026-09-01T08:00:00Z",
        Size: 451936256,
        Architecture: "arm64",
        Os: "linux",
        RepoTags: ["postgres:16"],
        Config: {
          ExposedPorts: { "5432/tcp": {} },
          Entrypoint: ["docker-entrypoint.sh"],
          Cmd: ["postgres"],
          Env: ["PATH=/usr/local/bin"],
        },
      }),
    )!;
    expect(iInspect.os).toBe("linux");
    expect(iInspect.architecture).toBe("arm64");
    expect(iInspect.exposedPorts).toEqual(["5432/tcp"]);

    const nInspect = parseNetworkInspect(
      JSON.stringify({
        Created: "2026-10-01T09:00:00Z",
        IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }] },
        Containers: { c1: { Name: "shop-db-1", IPv4Address: "172.18.0.2/16" } },
      }),
    )!;
    expect(nInspect.ipamConfigs[0]!.subnet).toBe("172.18.0.0/16");
    expect(nInspect.containers[0]!.name).toBe("shop-db-1");
  });
});

describe("docker compose detection and targets", () => {
  const playgroundCompose = [
    "# StarRocks local development environment",
    'version: "3.9"',
    "",
    "networks:",
    "  playground-network:",
    "    driver: bridge",
    "",
    "services:",
    "  starrocks:",
    "    container_name: starrocks",
    "    hostname: starrocks.local.com",
    "    po",
    "    image: starrocks/allin1-ubuntu:3.3.10",
    "    restart: unless-stopped",
    "    ports:",
    '      - "8030:8030"',
    "    healthcheck:",
    "      test: 'mysql -uroot'",
    "      interval: 10s",
    "      timeout: 5s",
    "      retries: 3",
    "    networks:",
    "      playground-network:",
    "",
    "  minio:",
    "    container_name: minio",
    "    image: minio/minio:latest",
    "    depends_on:",
    "      - starrocks",
  ].join("\n");

  it.each(["composeprod.yml", "mycompose.yaml", "team compose-dev.yml", "docker-compose.override.yaml"])(
    "recognises the Compose filename %s in detection and icons",
    (name) => {
      expect(isComposeFile(`/p/${name}`)).toBe(true);
      expect(fileIconName(name, `/p/${name}`)).toBe("file-docker");
    },
  );

  it.each([
    ["Kubernetes", "apiVersion: v1\nkind: Service\nservices:\n  web:\n    image: nginx\n"],
    ["OpenAPI", "openapi: 3.0.0\nservices:\n  web:\n    image: nginx\n"],
    ["Swagger", "swagger: '2.0'\nservices:\n  web:\n    image: nginx\n"],
    ["GitHub Actions", "on: push\njobs:\n  build:\n    services:\n      db:\n        image: postgres\n"],
    [
      "Ansible",
      "- hosts: all\n  tasks:\n    - name: Start services\n      services:\n        web:\n          image: nginx\n",
    ],
    ["Helm values", "name: shop\nreplicaCount: 1\nservices:\n  web:\n    image: nginx\n"],
    ["mkdocs", "site_name: Docs\nservices:\n  search:\n    image: example\n"],
    ["unrelated service list", "name: catalog\nservices:\n  web:\n    url: https://example.test\n"],
    ["embedded Compose example", "example: |\n  services:\n    web:\n      image: nginx\n"],
  ])("does not content-detect %s as Compose", (_name, content) => {
    expect(isComposeContent(content)).toBe(false);
    expect(fileTargets("/p/stack.yaml", content)).toEqual([]);
  });

  it("bounds content scanning by characters and lines", () => {
    expect(isComposeContent(`#${" ".repeat(70_000)}\nservices:\n  web:\n    image: nginx\n`)).toBe(false);
    expect(isComposeContent(`${"# comment\n".repeat(600)}services:\n  web:\n    image: nginx\n`)).toBe(false);
  });

  it("does not add run markers to extension or merge keys", () => {
    expect(
      composeTargets("services:\n  x-defaults:\n    image: nginx\n  <<: *services\n  web:\n    image: nginx\n"),
    ).toEqual([
      { kind: "composeAll", line: 0 },
      { kind: "composeService", line: 4, service: "web" },
    ]);
  });

  it("adds markers for services using aliases and inline mappings", () => {
    expect(composeTargets("services:\n  api: *defaults\n  db: {image: postgres}\n")).toEqual([
      { kind: "composeAll", line: 0 },
      { kind: "composeService", line: 1, service: "api" },
      { kind: "composeService", line: 2, service: "db" },
    ]);
  });

  it("recognises service names beginning with an underscore", () => {
    const content = "services:\n  _worker:\n    image: busybox\n";
    expect(isComposeContent(content)).toBe(true);
    expect(fileTargets("/p/stack.yml", content)).toEqual([
      { kind: "composeAll", line: 0 },
      { kind: "composeService", line: 1, service: "_worker" },
    ]);
  });

  it("detects compose files by name and content, and respects Keep / Not a Compose file overrides", () => {
    expect(isComposeFile("/git/gocommon/docker/playground-compose.yml")).toBe(true);
    expect(fileIconName("playground-compose.yml", "/git/gocommon/docker/playground-compose.yml")).toBe("file-docker");
    expect(isComposeContent(playgroundCompose)).toBe(true);
    expect(isComposeFile("/git/gocommon/docker/custom-stack.yml", playgroundCompose)).toBe(true);
    expect(isComposeContent("apiVersion: v1\nkind: Service\nmetadata:\n  name: my-svc\n")).toBe(false);

    const path = "/git/gocommon/docker/playground-compose.yml";
    expect(isAutoDetectedComposeFile(path, playgroundCompose)).toBe(false);
    expect(isAutoDetectedComposeFile("/p/stack.yml", playgroundCompose)).toBe(true);

    useComposeFiles.setState({ overrides: { [path]: "excluded" } });
    expect(isComposeFile(path, playgroundCompose)).toBe(false);
    expect(composeFileIcon("playground-compose.yml", path)).toBe("file-yaml");
    expect(fileTargets(path, playgroundCompose)).toEqual([]);

    useComposeFiles.setState({ overrides: { [path]: "kept" } });
    expect(isComposeFile(path)).toBe(true);
    expect(isAutoDetectedComposeFile(path, playgroundCompose)).toBe(false);
    expect(composeFileIcon("playground-compose.yml", path)).toBe("file-docker");
    useComposeFiles.setState({ overrides: {} });
  });

  it("locates compose targets per line and enclosing service at caret", () => {
    const targets = fileTargets("/git/gocommon/docker/playground-compose.yml", playgroundCompose);
    expect(targets).toEqual([
      { kind: "composeAll", line: 7 },
      { kind: "composeService", line: 8, service: "starrocks" },
      { kind: "composeService", line: 24, service: "minio" },
    ]);
    expect(composeTargetAtLine(playgroundCompose, 7)).toEqual({ kind: "composeAll", line: 7 });
    expect(composeTargetAtLine(playgroundCompose, 11)).toEqual({
      kind: "composeService",
      line: 8,
      service: "starrocks",
    });
    expect(composeTargetAtLine(playgroundCompose, 26)).toEqual({
      kind: "composeService",
      line: 24,
      service: "minio",
    });
  });

  it("completes and resolves internal service, network, volume, config and secret references", () => {
    const depPos = playgroundCompose.indexOf("      - starrocks") + "      - star".length;
    const depRes = composeCompletionsAt(playgroundCompose, depPos, false)!;
    expect(depRes.options.map((o) => o.label)).toEqual(["starrocks"]);

    const netPos = playgroundCompose.indexOf("      playground-network:") + "      play".length;
    const netRes = composeCompletionsAt(playgroundCompose, netPos, false)!;
    expect(netRes.options.map((o) => o.label)).toContain("playground-network");

    const state = EditorState.create({ doc: playgroundCompose });
    const model = parseComposeDocument(playgroundCompose);
    expect([...model.services.keys()]).toEqual(["starrocks", "minio"]);
    expect([...model.networks.keys()]).toEqual(["playground-network"]);

    const netRefOffset = playgroundCompose.indexOf("      playground-network:") + 8;
    const netDecl = resolveComposeReferenceAt(state, netRefOffset);
    expect(netDecl?.name).toBe("playground-network");
    expect(netDecl?.line).toBe(4);

    const svcRefOffset = playgroundCompose.indexOf("      - starrocks") + 10;
    const svcDecl = resolveComposeReferenceAt(state, svcRefOffset);
    expect(svcDecl?.name).toBe("starrocks");
    expect(svcDecl?.line).toBe(8);
  });
});
