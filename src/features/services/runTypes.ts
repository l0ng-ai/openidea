/**
 * Docker run configuration types (Add New Configuration › Docker), as in IDEA:
 * Dockerfile (build the image, then run a container from it), Docker Image (run
 * a container from an image) and Docker Compose (`up` the selected services).
 * They launch docker command lines in the Run tool window against the Docker
 * connection chosen from the Services tool window's connections; Stop stops the
 * container (`docker stop`) or takes the Compose project down.
 */
import { splitCommandLine } from "@/platform/commandLine";
import { call, commands, type RunConfig } from "@/platform/ipc";
import { registerRunConfigType, type RunConfigTypeContribution } from "@/workbench/contributions";
import { imageTag, targetTitle, type DockerTarget } from "./compose";
import { connections, endpointOf, loadSettings, useServices } from "./store";
import { tx } from "@/platform/i18n";

export const DOCKERFILE = "docker-dockerfile";
export const DOCKER_IMAGE = "docker-image";
export const DOCKER_COMPOSE = "docker-compose";

const GROUP = "Docker";
const on = (v: string | undefined) => v === "true";
const isWindows = () => typeof navigator !== "undefined" && /win/i.test(navigator.platform);

/** One word for the platform shell the run executes the line with (`/bin/sh -c` or `cmd /C`). */
export function shellQuote(word: string, windows = isWindows()): string {
  if (word && /^[\w@%+=:,./-]+$/.test(word)) return word;
  if (windows) return `"${word.replace(/"/g, '""')}"`;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

const line = (words: readonly string[], windows?: boolean) => words.map((w) => shellQuote(w, windows)).join(" ");

/** `a, b c` / `a; b` lists. */
const list = (text: string | undefined, separators = /[\s,;]+/) =>
  (text ?? "")
    .split(separators)
    .map((s) => s.trim())
    .filter(Boolean);

/** Container options shared by Dockerfile and Docker Image: name, ports, volumes, environment, extra options. */
function containerArgs(p: Readonly<Record<string, string>>): string[] {
  const args: string[] = [];
  for (const port of list(p.ports)) args.push("-p", port);
  for (const volume of list(p.volumes, /[;\n]+/)) args.push("-v", volume);
  for (const env of list(p.containerEnv, /[;\n]+/)) args.push("-e", env);
  args.push(...splitCommandLine(p.runOptions ?? ""));
  return args;
}

/** The container name: the given one, else one derived from the image (`my-app:latest` → `my-app`). */
export function containerName(p: Readonly<Record<string, string>>, image: string): string {
  const given = p.containerName?.trim();
  if (given) return given;
  const base =
    image
      .replace(/@.*$/, "")
      .replace(/:[^/:]*$/, "")
      .split("/")
      .pop() ?? "";
  return base.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[-_.]+/, "") || "container";
}

/**
 * Removes a previous container of the same name (IDEA redeploys over it), then runs
 * the new one attached, so its output is the run's output.
 */
function runContainer(name: string, image: string, p: Readonly<Record<string, string>>, windows: boolean): string {
  const remove = `${line(["docker", "rm", "-f", name], windows)} ${windows ? ">nul 2>&1 &" : ">/dev/null 2>&1;"}`;
  const run = [
    "docker",
    "run",
    "--name",
    name,
    ...(on(p.pull) ? ["--pull", "always"] : []),
    ...containerArgs(p),
    image,
  ];
  return `${remove} ${line([...run], windows)}${p.command?.trim() ? ` ${p.command.trim()}` : ""}`;
}

const connectionField = {
  key: "connection",
  label: "Server",
  control: "select" as const,
  // Read when the form renders: the Services tool window's Docker connections.
  get options() {
    if (!useServices.getState().settings) void loadSettings();
    const conns = connections();
    return conns.length ? conns.map((c) => ({ value: c.id, label: c.name })) : [{ value: "default", label: "Docker" }];
  },
};

const containerFields: RunConfigTypeContribution["fields"] = [
  { key: "containerName", label: "Container name", mono: true, placeholder: "Derived from the image" },
  { key: "ports", label: "Bind ports", mono: true, placeholder: "8080:80, 5005:5005" },
  { key: "volumes", label: "Bind mounts", mono: true, placeholder: "./data:/data; cache:/root/.cache" },
  { key: "containerEnv", label: "Container environment", mono: true, placeholder: "KEY=value; OTHER=value" },
  { key: "runOptions", label: "Run options", mono: true, placeholder: "e.g. --rm --network host" },
];

/** The connection's environment (daemon selection, docker on `PATH`) for the launched command line. */
async function withConnection(config: RunConfig): Promise<RunConfig> {
  await loadSettings();
  const env = await call(commands.dockerRunEnv(endpointOf(config.params?.connection || "default")));
  return { ...config, env: { ...env, ...config.env } };
}

export const dockerfileType: RunConfigTypeContribution = {
  id: DOCKERFILE,
  label: "Dockerfile",
  group: GROUP,
  icon: "file-docker",
  description: "Build an image from a Dockerfile and run a container from it",
  defaults: { connection: "default", dockerfile: "Dockerfile", runImage: "true" },
  ownsWorkingDirectory: true,
  fields: [
    connectionField,
    {
      key: "dockerfile",
      label: "Dockerfile",
      mono: true,
      required: true,
      browse: "file",
      placeholder: "Relative to the project root",
    },
    {
      key: "context",
      label: "Context folder",
      mono: true,
      browse: "directory",
      placeholder: "The Dockerfile's folder",
    },
    { key: "tag", label: "Image tag", mono: true, placeholder: "Derived from the context folder" },
    { key: "target", label: "Build stage", mono: true, placeholder: "The last stage" },
    { key: "buildArgs", label: "Build args", mono: true, placeholder: "KEY=value; OTHER=value" },
    { key: "buildOptions", label: "Build options", mono: true, placeholder: "e.g. --no-cache --platform linux/amd64" },
    { key: "runImage", label: "Run built image", control: "checkbox" },
    ...containerFields.map((f) => ({ ...f, visible: (p: Readonly<Record<string, string>>) => on(p.runImage) })),
    {
      key: "command",
      label: "Command",
      mono: true,
      placeholder: "The image's default",
      visible: (p) => on(p.runImage),
    },
  ],
  commandLine(p) {
    const windows = isWindows();
    const file = p.dockerfile?.trim() || "Dockerfile";
    const slash = file.replace(/\\/g, "/").lastIndexOf("/");
    const context = p.context?.trim() || (slash > 0 ? file.slice(0, slash) : ".");
    const tag = p.tag?.trim() || imageTag(`${context === "." ? "" : context}/Dockerfile`);
    const build = ["docker", "build", "-f", file, "-t", tag];
    if (p.target?.trim()) build.push("--target", p.target.trim());
    for (const arg of list(p.buildArgs, /[;\n]+/)) build.push("--build-arg", arg);
    build.push(...splitCommandLine(p.buildOptions ?? ""), context);
    if (!on(p.runImage)) return { command: line(build, windows), args: [], cwd: null };
    const name = containerName(p, tag);
    return {
      command: `${line(build, windows)} && (${runContainer(name, tag, p, windows)})`,
      args: [],
      cwd: null,
      stop: line(["docker", "stop", name], windows),
    };
  },
  prepareLaunch: withConnection,
};

export const dockerImageType: RunConfigTypeContribution = {
  id: DOCKER_IMAGE,
  label: "Docker Image",
  group: GROUP,
  icon: "file-docker",
  description: "Run a container from an image",
  defaults: { connection: "default" },
  ownsWorkingDirectory: true,
  fields: [
    connectionField,
    { key: "image", label: "Image ID or name", mono: true, required: true, placeholder: "e.g. postgres:16" },
    { key: "pull", label: "Pull the image before running", control: "checkbox" },
    ...containerFields,
    { key: "command", label: "Command", mono: true, placeholder: "The image's default" },
  ],
  commandLine(p) {
    const windows = isWindows();
    const image = p.image?.trim() ?? "";
    const name = containerName(p, image);
    return {
      command: `(${runContainer(name, image, p, windows)})`,
      args: [],
      cwd: null,
      stop: line(["docker", "stop", name], windows),
    };
  },
  prepareLaunch: withConnection,
};

export const dockerComposeType: RunConfigTypeContribution = {
  id: DOCKER_COMPOSE,
  label: "Docker Compose",
  group: GROUP,
  icon: "file-docker",
  description: "Start the services of Compose files",
  defaults: { connection: "default", files: "docker-compose.yml" },
  ownsWorkingDirectory: true,
  fields: [
    connectionField,
    {
      key: "files",
      label: "Compose files",
      mono: true,
      required: true,
      placeholder: "docker-compose.yml; docker-compose.override.yml",
    },
    { key: "services", label: "Services", mono: true, placeholder: "All services" },
    { key: "project", label: "Project name", mono: true, placeholder: "The folder name" },
    { key: "detach", label: "Run in the background (-d)", control: "checkbox" },
    { key: "build", label: "Build images before starting (--build)", control: "checkbox" },
    { key: "upOptions", label: "Up options", mono: true, placeholder: "e.g. --force-recreate --remove-orphans" },
  ],
  commandLine(p) {
    const windows = isWindows();
    const base = ["docker", "compose"];
    for (const f of list(p.files, /[;\n]+/)) base.push("-f", f);
    if (p.project?.trim()) base.push("-p", p.project.trim());
    const up = [...base, "up"];
    if (on(p.detach)) up.push("-d");
    if (on(p.build)) up.push("--build");
    up.push(...splitCommandLine(p.upOptions ?? ""), ...list(p.services));
    // Attached: Stop takes the project down. Detached, `up` returns once the services started.
    return {
      command: line(up, windows),
      args: [],
      cwd: null,
      stop: on(p.detach) ? null : line([...base, "down"], windows),
    };
  },
  prepareLaunch: withConnection,
};

export const DOCKER_RUN_TYPES = [dockerfileType, dockerImageType, dockerComposeType];

/** A configuration of `type` with `params` and the command line they produce. */
export function typedConfig(
  type: RunConfigTypeContribution,
  id: string,
  name: string,
  params: Record<string, string>,
): RunConfig {
  const cmd = type.commandLine(params);
  return {
    id,
    name,
    kind: type.id,
    command: cmd?.command ?? "",
    args: cmd?.args ?? [],
    cwd: cmd?.cwd ?? null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: null,
    params,
    ...(cmd?.stop ? { stopCommand: cmd.stop } : {}),
  };
}

/** `path` for a configuration that runs in the project root: relative when inside it. */
const projectPath = (path: string, root: string | null) =>
  root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

/** The configurations a gutter icon offers, as IDEA's Dockerfile / Compose gutter menus. */
export function gutterActions(
  t: DockerTarget,
  path: string,
  root: string | null,
): Array<{ title: string; config: RunConfig }> {
  const file = projectPath(path, root);
  const folder = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
  const connection = connections()[0]?.id ?? "default";
  switch (t.kind) {
    case "build": {
      const params = { connection, dockerfile: file, context: folder, tag: imageTag(path) };
      if (t.stage && !t.last) {
        const config = typedConfig(dockerfileType, `docker:build:${file}:${t.stage}`, `${file} [${t.stage}]`, {
          ...params,
          target: t.stage,
        });
        return [{ title: targetTitle(t, path), config }];
      }
      return [
        {
          title: targetTitle(t, path),
          config: typedConfig(dockerfileType, `docker:dockerfile:${file}`, file, { ...params, runImage: "true" }),
        },
        {
          title: tx`Build Image '${params.tag}'`,
          config: typedConfig(dockerfileType, `docker:build:${file}`, `Build ${file}`, params),
        },
      ];
    }
    case "composeAll":
      return [
        {
          title: targetTitle(t, path),
          config: typedConfig(dockerComposeType, `docker:compose:${file}`, `${file}: Compose Deployment`, {
            connection,
            files: file,
          }),
        },
      ];
    case "composeService":
      return [
        {
          title: targetTitle(t, path),
          config: typedConfig(dockerComposeType, `docker:compose:${file}:${t.service}`, `${file}: ${t.service}`, {
            connection,
            files: file,
            services: t.service,
          }),
        },
      ];
  }
}

export function registerDockerRunTypes(): () => void {
  const disposers = DOCKER_RUN_TYPES.map(registerRunConfigType);
  return () => disposers.forEach((d) => d());
}
