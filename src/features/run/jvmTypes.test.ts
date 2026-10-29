import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";

const scripts: string[][] = [];
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      runGradleJvmArgsScript: (jvmArgs: string[]) => {
        scripts.push(jvmArgs);
        return Promise.resolve({ status: "ok", data: "/tmp/openidea-gradle/jvm-args-1.init.gradle" });
      },
    },
  };
});

const { parseJavaArgs, joinJavaArgs } = await import("@/platform/javaLaunch");
const { parseArgs } = await import("./configs");
const { jdwpLaunch } = await import("./javaDebug");
const { applicationType, gradleJvmArgs, joinPropertyArgs, springBootType } = await import("./jvmTypes");
const { formParams, newConfigOfType, registerBuiltinTypes, typeFor, withParams } = await import("./types");

const REPORTER_VM = "-Ddemo.flag=on --add-opens java.base/java.lang=ALL-UNNAMED";

const cfg = (over: Partial<RunConfig>): RunConfig => ({
  id: "c",
  name: "c",
  kind: "spring-boot",
  command: "java",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: "java-debug",
  ...over,
});

let dispose: () => void;
beforeEach(() => {
  dispose = registerBuiltinTypes();
  scripts.length = 0;
});
afterEach(() => dispose());

describe("Application / Spring Boot command line", () => {
  it.each([
    ["application", applicationType],
    ["spring-boot", springBootType],
  ] as const)("%s puts VM options before the main class and program arguments after it", (_, type) => {
    const line = type.commandLine({
      mainClass: "com.example.Application",
      vmOptions: REPORTER_VM,
      programArgs: "--server.port=8081 'two words'",
      classpath: "${classpath}",
    });
    expect(line).toEqual({
      command: "java",
      args: [
        "-Ddemo.flag=on",
        "--add-opens",
        "java.base/java.lang=ALL-UNNAMED",
        "-cp",
        "${classpath}",
        "com.example.Application",
        "--server.port=8081",
        "two words",
      ],
    });
    const parsed = parseJavaArgs(line!.args);
    expect(parsed.vmArgs).toEqual(["-Ddemo.flag=on", "--add-opens", "java.base/java.lang=ALL-UNNAMED"]);
    expect(parsed.mainClass).toBe("com.example.Application");
    expect(parsed.programArgs).toEqual(["--server.port=8081", "two words"]);
  });

  it("reads VM options over several lines and with quoted spaces", () => {
    const line = applicationType.commandLine({
      mainClass: "a.Main",
      vmOptions: '-Xmx1g\n-Dapp.name="My App"\n  -Dempty=""',
    });
    expect(line!.args.slice(0, 3)).toEqual(["-Xmx1g", "-Dapp.name=My App", "-Dempty="]);
    expect(joinJavaArgs(parseJavaArgs(line!.args).vmArgs)).toBe('-Xmx1g "-Dapp.name=My App" -Dempty=');
  });

  it("keeps Windows paths as typed on Windows", () => {
    expect(parseArgs(String.raw`-javaagent:C:\tools\agent.jar "-Dlog=C:\Program Files\x.log"`, true)).toEqual([
      String.raw`-javaagent:C:\tools\agent.jar`,
      String.raw`-Dlog=C:\Program Files\x.log`,
    ]);
    expect(parseArgs(String.raw`-Dq=\"x\" "a \"b\""`, true)).toEqual(['-Dq="x"', 'a "b"']);
    // Elsewhere a backslash still escapes.
    expect(parseArgs(String.raw`a\ b`)).toEqual(["a b"]);
  });

  it("passes Spring Boot's active profiles before the program arguments", () => {
    const line = springBootType.commandLine({ mainClass: "a.App", activeProfiles: "dev,local", programArgs: "--x" });
    expect(line!.args).toEqual(["-cp", "${classpath}", "a.App", "--spring.profiles.active=dev,local", "--x"]);
    // Application has no profiles field.
    expect(applicationType.commandLine({ mainClass: "a.App", activeProfiles: "dev" })!.args).toEqual([
      "-cp",
      "${classpath}",
      "a.App",
    ]);
  });

  it("uses the test classpath when chosen", () => {
    expect(applicationType.commandLine({ mainClass: "a.T", classpath: "${testClasspath}" })!.args).toEqual([
      "-cp",
      "${testClasspath}",
      "a.T",
    ]);
  });
});

describe("configurations saved or detected as a raw command line", () => {
  it("opens a detected Spring Boot configuration in the form", () => {
    const detected = cfg({ args: ["-cp", "${classpath}", "com.example.DemoApplication"], detected: true });
    expect(formParams(detected)).toEqual({
      mainClass: "com.example.DemoApplication",
      vmOptions: "",
      programArgs: "",
      classpath: "${classpath}",
    });
  });

  it("splits an older configuration's arguments into VM options, main class, profiles and program arguments", () => {
    const old = cfg({
      args: ["-Xmx1g", "-Dname=a b", "-cp", "${classpath}", "a.App", "--spring.profiles.active=dev", "x y"],
    });
    const params = formParams(old);
    expect(params).toEqual({
      mainClass: "a.App",
      vmOptions: "-Xmx1g '-Dname=a b'",
      programArgs: "'x y'",
      classpath: "${classpath}",
      activeProfiles: "dev",
    });
    // Editing VM options keeps the rest of the command line.
    const next = withParams(old, { ...params!, vmOptions: REPORTER_VM });
    expect(next.args).toEqual([
      "-Ddemo.flag=on",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      "-cp",
      "${classpath}",
      "a.App",
      "--spring.profiles.active=dev",
      "x y",
    ]);
    expect(next.params).toMatchObject({ vmOptions: REPORTER_VM });
  });

  it("keeps an explicit classpath and edits other command lines as a command", () => {
    expect(formParams(cfg({ kind: "application", args: ["-cp", "lib/*", "a.Main"] }))).toMatchObject({
      classpath: "lib/*",
    });
    expect(formParams(cfg({ command: "./run.sh", args: ["a.Main"] }))).toBeNull();
    expect(formParams(cfg({ args: ["a.Main"] }))).toBeNull();
  });

  it("prefers the stored params", () => {
    const c = cfg({
      params: { mainClass: "a.App", vmOptions: "-Xss2m" },
      args: ["-Xss2m", "-cp", "${classpath}", "a.App"],
    });
    expect(formParams(c)).toEqual({ mainClass: "a.App", vmOptions: "-Xss2m" });
  });
});

describe("templates", () => {
  it("applies the template's VM options to a new configuration", () => {
    const template = cfg({ id: "template:spring-boot", params: { classpath: "${classpath}", vmOptions: "-Xmx512m" } });
    const c = newConfigOfType(springBootType, [], template);
    expect(c.kind).toBe("spring-boot");
    expect(c.debugAdapter).toBe("java-debug");
    expect(c.params).toMatchObject({ vmOptions: "-Xmx512m" });
    expect(c.args).toEqual(["-Xmx512m", "-cp", "${classpath}"]);
  });
});

describe("Maven / Gradle: VM options of the forked JVM", () => {
  const maven = () => typeFor("maven")!;
  const gradle = () => typeFor("gradle")!;

  it("passes spring-boot:run's VM options and profiles to the application, not to Maven", () => {
    const line = maven().commandLine({
      tasks: "spring-boot:run",
      vmOptions: REPORTER_VM + " '-Dname=a b'",
      activeProfiles: "dev",
    });
    expect(line!.args).toEqual([
      "spring-boot:run",
      `-Dspring-boot.run.jvmArguments=-Ddemo.flag=on --add-opens java.base/java.lang=ALL-UNNAMED "-Dname=a b"`,
      "-Dspring-boot.run.profiles=dev",
    ]);
    // Debugging adds the JDWP agent to the same property.
    const debug = jdwpLaunch(cfg({ kind: "maven", command: "mvn", args: line!.args }));
    expect(debug!.args[1]).toMatch(/^-Dspring-boot\.run\.jvmArguments=-Ddemo\.flag=on .* -agentlib:jdwp=/);
  });

  it("passes test goals' VM options to Surefire and nothing for other goals", () => {
    expect(maven().commandLine({ tasks: "test", vmOptions: "-Xmx1g" })!.args).toEqual(["test", "-DargLine=-Xmx1g"]);
    expect(maven().commandLine({ tasks: "package", vmOptions: "-Xmx1g" })!.args).toEqual(["package"]);
    const vm = maven().fields.find((f) => f.key === "vmOptions")!;
    expect(vm.visible!({ tasks: "clean spring-boot:run" })).toBe(true);
    expect(vm.visible!({ tasks: "package" })).toBe(false);
  });

  it("quotes property values the plugins split", () => {
    expect(joinPropertyArgs(["-Xmx1g", "-Dp=C:\\Program Files\\x", 'say "hi"', ""])).toBe(
      `-Xmx1g "-Dp=C:\\Program Files\\x" 'say "hi"' ""`,
    );
  });

  it("hands Gradle's VM options to an init script for the forked JVMs", async () => {
    const params = { tasks: "bootRun", vmOptions: REPORTER_VM, activeProfiles: "dev", wrapper: "true" };
    expect(gradleJvmArgs(params)).toEqual([
      "-Ddemo.flag=on",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      "-Dspring.profiles.active=dev",
    ]);
    expect(gradleJvmArgs({ tasks: "build", vmOptions: "-Xmx1g" })).toEqual([]);
    const c = withParams(cfg({ kind: "gradle" }), params);
    // Gradle's own command line is unchanged.
    expect(c.args).toEqual(["bootRun"]);
    const launched = await gradle().prepareLaunch!(c);
    expect(scripts).toEqual([gradleJvmArgs(params)]);
    expect(launched.args).toEqual(["--init-script", "/tmp/openidea-gradle/jvm-args-1.init.gradle", "bootRun"]);
    // Debugging keeps them: `--debug-jvm` is added before the launch is prepared.
    const debug = await gradle().prepareLaunch!(jdwpLaunch(c)!);
    expect(debug.args).toEqual([
      "--init-script",
      "/tmp/openidea-gradle/jvm-args-1.init.gradle",
      "bootRun",
      "--debug-jvm",
    ]);
  });

  it("leaves Gradle configurations without VM options alone", async () => {
    const c = withParams(cfg({ kind: "gradle" }), { tasks: "bootRun" });
    expect(await gradle().prepareLaunch!(c)).toBe(c);
    expect(scripts).toEqual([]);
    const remote = withParams(cfg({ kind: "gradle", target: "ssh-1" }), { tasks: "bootRun", vmOptions: "-Xmx1g" });
    await expect(gradle().prepareLaunch!(remote)).rejects.toThrow(/run targets/);
  });
});
