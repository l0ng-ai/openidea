import { describe, expect, it } from "vitest";
import { pageLabels } from "../pages/registry";
import { validateRunTargets } from "@/platform/remoteSettings";
import { parentPath, splitList } from "../pages/runTargets";

describe("Run Targets page", () => {
  it("is found by its fields", () => {
    expect(pageLabels("build.runTargets")).toEqual(
      expect.arrayContaining(["SSH configuration", "Project folder on target", "Python interpreter"]),
    );
    expect(pageLabels("build.runTargets")).toEqual(
      expect.arrayContaining(["Docker connection", "Image", "Service", "Published ports"]),
    );
  });

  it("reads SSH targets saved before container ones existed, and container fields", () => {
    const [ssh, compose] = validateRunTargets([
      { id: "box", name: "Box", sshConfig: "s" },
      { kind: "compose", id: "web", composeFiles: ["compose.yaml", 3], service: "web", ports: ["8000:8000"] },
    ]);
    expect(ssh).toMatchObject({ kind: "ssh", sshConfig: "s", image: "", composeFiles: [], imageUser: false });
    expect(compose).toMatchObject({
      kind: "compose",
      composeFiles: ["compose.yaml"],
      service: "web",
      ports: ["8000:8000"],
    });
    expect(validateRunTargets([{ kind: "kubernetes", id: "k" }])[0]!.kind).toBe("ssh");
  });

  it("splits ports and file lists", () => {
    expect(splitList(" 8000:8000, 5678:5678;a.yaml  ")).toEqual(["8000:8000", "5678:5678", "a.yaml"]);
    expect(splitList("  ")).toEqual([]);
  });

  it("walks up remote folders", () => {
    expect(parentPath("/home/me/app")).toBe("/home/me");
    expect(parentPath("/home/")).toBe("/");
    expect(parentPath("~/app")).toBe("~");
    expect(parentPath("~")).toBeNull();
    expect(parentPath("/")).toBeNull();
  });
});
