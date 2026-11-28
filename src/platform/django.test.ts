import { expect, it } from "vitest";
import { pickManage } from "./django";

const PATHS = [
  "/p/.venv/lib/python3.12/site-packages/x/manage.py",
  "/p/shop/manage.py",
  "/p/blog/manage.py",
  "/p/blog/admin/manage.py",
];

it("picks the manage.py of the file's own Django project", () => {
  expect(pickManage(PATHS, "/p/shop/shop/views.py")).toBe("/p/shop/manage.py");
  expect(pickManage(PATHS, "/p/blog/admin/urls.py")).toBe("/p/blog/admin/manage.py");
  // Elsewhere (or no file): the shallowest, by name among equals; never an installed one.
  expect(pickManage(PATHS, "/p/README.md")).toBe("/p/blog/manage.py");
  expect(pickManage(PATHS)).toBe("/p/blog/manage.py");
  expect(pickManage(PATHS.slice(0, 1))).toBeNull();
});
