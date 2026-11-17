import { describe, expect, it } from "vitest";
import { validateSettings } from "../model/schema";
import { DEFAULT_CMAKE_PROFILE } from "@/platform/cmakeSettings";

describe("CMake settings", () => {
  it("preserves absent and explicitly empty profiles", () => {
    expect(validateSettings({}).cmake).toEqual({});
    expect(validateSettings({ cmake: { profiles: [] } }).cmake.profiles).toEqual([]);
  });
  it("keeps the Visual Studio toolchain and architecture, System when absent", () => {
    const toolchain = String.raw`C:\Program Files\Microsoft Visual Studio\2022\Community`;
    const [msvc, system, malformed] =
      validateSettings({
        cmake: { profiles: [{ toolchain, toolchainArch: "x64_arm64" }, {}, { toolchain: 3, toolchainArch: null }] },
      }).cmake.profiles ?? [];
    expect(msvc).toMatchObject({ toolchain, toolchainArch: "x64_arm64" });
    expect(system).toMatchObject({ toolchain: "", toolchainArch: "" });
    expect(malformed).toMatchObject({ toolchain: "", toolchainArch: "" });
  });
  it("preserves argument arrays and drops malformed argument values", () => {
    const cmakeArgs = ["-DMESSAGE=two words", '-DQUOTE="hello"', ""];
    const buildArgs = ["-j", "8", "--", "LABEL=it's a build"];
    const profiles = validateSettings({ cmake: { profiles: [{ cmakeArgs, buildArgs }] } }).cmake.profiles;
    expect(profiles?.[0]).toMatchObject({ cmakeArgs, buildArgs });
    expect(
      validateSettings({ cmake: { profiles: [{ cmakeArgs: ["-DFOO=bar", 42, null] }] } }).cmake.profiles?.[0]
        ?.cmakeArgs,
    ).toEqual(["-DFOO=bar"]);
  });
  it("retains custom types and generators while normalizing malformed fields", () => {
    expect(
      validateSettings({
        cmake: {
          profiles: [
            {
              name: "Custom",
              buildType: "Coverage",
              generator: "Custom generator",
              buildArgs: 5,
              env: { KEEP: "yes", DROP: 5 },
            },
            null,
          ],
        },
      }).cmake.profiles,
    ).toEqual([
      {
        ...DEFAULT_CMAKE_PROFILE,
        name: "Custom",
        buildType: "Coverage",
        generator: "Custom generator",
        env: { KEEP: "yes" },
      },
    ]);
  });
});
