/**
 * Java debugging through Microsoft java-debug, a jdtls bundle: jdtls starts its
 * DAP server (`vscode.java.startDebugSession`) and the session connects to that
 * port (`debugServer`). Application configurations are launched by java-debug;
 * JVMs started by Maven / Gradle with a JDWP agent are attached to.
 */
import { executeAction } from "@/platform/actions";
import { call, commands, IpcError, type LaunchConfig, type RunConfig } from "@/platform/ipc";
import {
  formatCompileErrors,
  isJvmApplication,
  joinJavaArgs,
  parseJavaArgs,
  resolveJavaCommand,
} from "@/platform/javaLaunch";
import { notifications } from "@/workbench/contributions";

export const JAVA_ADAPTER = "java-debug";
export const KOTLIN_ADAPTER = "kotlin-debug-adapter";

export function isJavaDebuggable(rc: RunConfig): boolean {
  return isJvmApplication(rc) && [JAVA_ADAPTER, KOTLIN_ADAPTER].includes(rc.debugAdapter ?? JAVA_ADAPTER);
}

function join(base: string, p: string) {
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return p;
  const rel = p.replace(/^\.\//, "");
  return rel === "." || rel === "" ? base : `${base.replace(/\/$/, "")}/${rel}`;
}

/** Conventional JVM source sets, including Kotlin kept in a Java source directory.
 * A mixed module uses Kotlin's adapter, which also accepts Java line breakpoints.
 */
export async function moduleHasKotlinSources(cwd: string): Promise<boolean> {
  const pending = [join(cwd, "src")];
  while (pending.length) {
    const path = pending.pop()!;
    const entries = await call(commands.fsReadDir(path)).catch(() => []);
    for (const entry of entries) {
      if (entry.excluded) continue;
      if ((entry.kind === "file" || entry.targetKind === "file") && entry.name.endsWith(".kt")) return true;
      // Do not follow directory symlinks: a source tree can link back to a parent.
      if (entry.kind === "dir") pending.push(entry.path);
    }
  }
  return false;
}

/** java-debug missing from jdtls: offer the one-click install (jdtls restarts with the bundle). */
function offerInstall(e: unknown): never {
  if (e instanceof IpcError && e.kind === "unavailable" && /java-debug|debugger/i.test(e.message)) {
    notifications().notify({
      group: "run",
      level: "warning",
      key: "debug.java-debug-missing",
      title: "The Java debugger is not installed",
      body: "Debugging Java needs Microsoft java-debug, loaded into the Java language server. Install it and debug again once jdtls has restarted.",
      sticky: true,
      actions: [{ label: "Install", run: () => void executeAction("tools.install", JAVA_ADAPTER) }],
    });
  }
  throw e;
}

async function debugServer(module: string): Promise<number> {
  try {
    return await call(commands.javaDebugServer(module));
  } catch (e) {
    offerInstall(e);
  }
}

/** Launch request for an Application configuration (`java … -cp ${classpath} Main args`). */
export async function javaLaunchConfig(rc: RunConfig, root: string): Promise<LaunchConfig> {
  const module = rc.cwd ?? "";
  const cwd = rc.cwd ? join(root, rc.cwd) : root;
  const parsed = parseJavaArgs(rc.args);
  if (!parsed.mainClass) throw new Error(`No main class in '${rc.name}'`);
  const info = await call(commands.javaResolveLaunch(module, parsed.classpath === "test", true));
  if (info.errorCount > 0)
    notifications().notify({
      group: "run",
      level: "warning",
      key: "debug.java-compile-errors",
      title: `'${rc.name}' has compile errors; debugging the last compiled classes`,
      body: formatCompileErrors(info).trimEnd(),
    });
  const resolved = resolveJavaCommand(rc, info);
  const kotlin = rc.debugAdapter === KOTLIN_ADAPTER || (await moduleHasKotlinSources(cwd));
  const classPaths = parsed.explicitClasspath ? parsed.explicitClasspath.split(/[:;]/) : info.classPaths;
  if (kotlin) {
    return {
      name: rc.name,
      adapter: KOTLIN_ADAPTER,
      request: "launch",
      program: null,
      args: [],
      cwd,
      env: { ...rc.env },
      extraJson: JSON.stringify({
        projectRoot: cwd,
        mainClass: parsed.mainClass,
        classPaths,
        modulePaths: info.modulePaths,
        javaExec: resolved.command,
        vmArguments: parsed.vmArgs,
        programArgs: parsed.programArgs,
      }),
    };
  }
  const port = await debugServer(module);
  return {
    name: rc.name,
    adapter: JAVA_ADAPTER,
    request: "launch",
    program: null,
    // java-debug takes `args` / `vmArgs` as strings.
    args: [],
    cwd,
    env: { ...rc.env },
    extraJson: JSON.stringify({
      debugServer: port,
      mainClass: parsed.mainClass,
      classPaths,
      modulePaths: info.modulePaths,
      javaExec: resolved.command === "java" ? undefined : resolved.command,
      vmArgs: joinJavaArgs(parsed.vmArgs),
      args: joinJavaArgs(parsed.programArgs),
      // java-debug spawns the JVM itself: it must shorten a classpath too long for the OS the same way Run does.
      shortenCommandLine: info.shortenCommandLine ?? "none",
      console: "internalConsole",
      stopOnEntry: false,
    }),
  };
}

export interface JavaAttachTarget {
  name: string;
  /** Module directory (relative to the project root) whose jdtls resolves sources. */
  module: string;
  hostName: string;
  port: number;
}

export function isJavaAttachTarget(
  arg: unknown,
): arg is JavaAttachTarget & { process?: number | null; runConfig?: RunConfig } {
  return !!arg && typeof arg === "object" && "port" in arg && typeof (arg as { port: unknown }).port === "number";
}

/** Attach request for a JVM listening with a JDWP agent. */
export async function javaAttachConfig(target: JavaAttachTarget, root: string): Promise<LaunchConfig> {
  const cwd = target.module ? join(root, target.module) : root;
  if (await moduleHasKotlinSources(cwd)) {
    return {
      name: target.name,
      adapter: KOTLIN_ADAPTER,
      request: "attach",
      program: null,
      args: [],
      cwd,
      env: {},
      extraJson: JSON.stringify({ projectRoot: cwd, hostName: target.hostName, port: target.port, timeout: 30_000 }),
    };
  }
  const port = await debugServer(target.module);
  return {
    name: target.name,
    adapter: JAVA_ADAPTER,
    request: "attach",
    program: null,
    args: [],
    cwd: target.module ? join(root, target.module) : root,
    env: {},
    extraJson: JSON.stringify({ debugServer: port, hostName: target.hostName, port: target.port, timeout: 30_000 }),
  };
}
