import { describe, expect, it } from "vitest";
import { validateVcs } from "@/platform/workflowSettings";
import { mappingKey } from "../pages/vcs";

describe("Directory Mappings", () => {
  it("stores directories relative to the project root, absolute outside it", () => {
    expect(mappingKey("/work/app", "/work/app")).toBe(".");
    expect(mappingKey("/work/app", "/work/app/")).toBe(".");
    expect(mappingKey("/work/app", "/work/app/reference-sdk")).toBe("reference-sdk");
    expect(mappingKey("/work/app", "/work/app/libs/core")).toBe("libs/core");
    expect(mappingKey("/work/app", "/work/application")).toBe("/work/application");
    expect(mappingKey("/work/app", "/opt/sdk")).toBe("/opt/sdk");
    expect(mappingKey("C:\\work\\app", "C:\\work\\app\\libs\\core")).toBe("libs/core");
  });

  it("reads the mappings from settings, dropping malformed entries", () => {
    expect(validateVcs({}).mappings).toEqual({ excluded: [], added: [] });
    expect(validateVcs({ mappings: { excluded: ["sdk", 3, ""], added: "x" } }).mappings).toEqual({
      excluded: ["sdk"],
      added: [],
    });
  });
});
