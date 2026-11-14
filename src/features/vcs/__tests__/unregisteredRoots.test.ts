import { describe, expect, it } from "vitest";
import { projectRelative, unregisteredRootsBody, unregisteredRootsNotice } from "../unregisteredRoots";

const ROOT = "/work/app";

describe("unregistered Git roots", () => {
  it("lists up to three paths relative to the project and counts the rest", () => {
    expect(unregisteredRootsBody([`${ROOT}/services/api`, `${ROOT}/tools/cli`], ROOT)).toBe("services/api, tools/cli");
    const five = ["a", "b", "c", "d", "e"].map((name) => `${ROOT}/${name}`);
    expect(unregisteredRootsBody(five, ROOT)).toBe("a, b, c +2 more");
  });

  it("keeps paths outside the project as they are", () => {
    expect(projectRelative(ROOT, "/elsewhere/repo")).toBe("/elsewhere/repo");
    expect(projectRelative(null, `${ROOT}/nested`)).toBe(`${ROOT}/nested`);
  });

  it("offers one sticky action that reruns the project's scan", () => {
    const notice = unregisteredRootsNotice([`${ROOT}/nested`], ROOT);
    expect(notice).toMatchObject({
      group: "vcs",
      level: "info",
      key: "vcs.unregisteredRoots",
      title: "Unregistered Git repositories",
      body: "nested",
      sticky: true,
    });
    expect(notice.actions).toHaveLength(1);
    expect(notice.actions?.[0]?.label).toBe("Add to Project");
  });
});
