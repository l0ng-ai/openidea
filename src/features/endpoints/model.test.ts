import { describe, expect, it } from "vitest";
import { diagnosticLines, distinct, filterEndpoints, groupBy, navigationTarget } from "./model";
import { endpoint } from "./testEndpoint";

const ROOT = "/p/app";

const ENDPOINTS = [
  endpoint("GET", "/photos", "photos#index", { name: "photos", line: 4 }),
  endpoint("POST", "/photos", "photos#create", { line: 4 }),
  endpoint("GET", "/admin/stats", "admin/stats#index", {
    targetClass: "Admin::StatsController",
    file: `${ROOT}/config/routes/admin.rb`,
    line: 2,
    module: "admin",
  }),
];

describe("endpoints model", () => {
  it("filters by every word, case-insensitively, over method, path, target and name", () => {
    expect(filterEndpoints(ENDPOINTS, "")).toHaveLength(3);
    expect(filterEndpoints(ENDPOINTS, "post").map((e) => e.path)).toEqual(["/photos"]);
    expect(filterEndpoints(ENDPOINTS, "GET photo").map((e) => e.path)).toEqual(["/photos"]);
    expect(filterEndpoints(ENDPOINTS, "statscontroller").map((e) => e.path)).toEqual(["/admin/stats"]);
    expect(filterEndpoints(ENDPOINTS, "nothing here")).toEqual([]);
  });

  it("groups in first-use order", () => {
    expect(groupBy(ENDPOINTS, (e) => e.module).map((g) => [g.key, g.endpoints.length])).toEqual([
      ["app", 2],
      ["admin", 1],
    ]);
    expect(distinct(ENDPOINTS.map((e) => e.file)).map((f) => f.split("/").pop())).toEqual(["routes.rb", "admin.rb"]);
  });

  it("navigates to the declaration, 0-based", () => {
    expect(navigationTarget(ENDPOINTS[2]!)).toEqual({ path: `${ROOT}/config/routes/admin.rb`, line: 1, col: 0 });
    expect(navigationTarget(endpoint("GET", "/", "a#b", { line: 0 })).line).toBe(0);
  });

  it("formats diagnostics relative to the project", () => {
    expect(
      diagnosticLines([{ file: `${ROOT}/config/routes.rb`, line: 12, message: "`draw :missing`: not found" }], ROOT),
    ).toEqual(["config/routes.rb:12: `draw :missing`: not found"]);
  });
});
