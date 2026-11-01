import { describe, expect, it } from "vitest";
import { validateSettings } from "../model/schema";
import { DEFAULT_CMAKE_PROFILE } from "@/platform/cmakeSettings";

describe("CMake settings", () => {
  it("preserves absent and explicitly empty profiles", () => {
    expect(validateSettings({}).cmake).toEqual({});
    expect(validateSettings({ cmake: { profiles: [] } }).cmake.profiles).toEqual([]);
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
