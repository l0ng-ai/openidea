import { expect, it, vi } from "vitest";
import {
  onSearchCategoriesChanged,
  registerSearchCategory,
  searchCategories,
  type SearchCategory,
} from "./contributions";
it("namespaces identical category names and does not let an old disposer remove a replacement", () => {
  const changed = vi.fn();
  const off = onSearchCategoriesChanged(changed);
  const category = (id: SearchCategory["id"]): SearchCategory => ({
    id,
    title: "Routes",
    search: async () => ({ items: [], hasMore: false }),
    command: () => undefined,
  });
  const first = registerSearchCategory(category("plugin:first:routes"));
  const second = registerSearchCategory(category("plugin:second:routes"));
  const replacement = registerSearchCategory(category("plugin:first:routes"));
  first();
  expect(searchCategories().map((c) => c.id)).toEqual(["plugin:first:routes", "plugin:second:routes"]);
  replacement();
  second();
  off();
  expect(searchCategories()).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(5);
});
