import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const ipc = vi.hoisted(() => ({ files: {} as Record<string, string>, invalidate: vi.fn() }));
vi.mock("@/editor/navigationProviders", () => ({ invalidateNavigationProviders: ipc.invalidate }));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  commands: {
    findFilesNamed: () => ok(Object.keys(ipc.files)),
    fsReadText: (path: string) => ok(ipc.files[path]),
  },
}));

const { forgetUrlNames, parseUrls, projectUrlNames, resolveUrlNames, urlCompletion, urlNameAt, urlNavigation } =
  await import("./urls");

const SHOP = `from django.urls import include, path

app_name = "shop"

urlpatterns = [
    path("", views.product_list, name="products"),
    path("products/<slug:slug>/", views.product_detail, name='product'),
    # path("old/", views.old, name="old"),
    path("api/", include("shop.api.urls")),
]
special = Product.objects.filter(name="not-a-url")
`;
const API = `app_name = "api"
urlpatterns = [path("items/", views.items, name="item")]
`;
const ROOT = `urlpatterns = [
    path("", include("shop.urls")),
    path("v2/", include("shop.urls", namespace="shop-v2")),
    path("blog/", include(("blog.urls", "blog"))),
    path("", home, name="home"),
]
`;
const BLOG = `urlpatterns = [path("", index, name="index")]\n`;

const names = (files: Record<string, string>) =>
  resolveUrlNames(Object.entries(files).map(([p, t]) => parseUrls(p, t)))
    .map((u) => u.name)
    .sort();

beforeEach(() => {
  forgetUrlNames();
  ipc.invalidate.mockClear();
});

describe("URL names", () => {
  it("reads named patterns: not comments, not other calls' name=", () => {
    const shop = parseUrls("/p/shop/urls.py", SHOP);
    expect(shop.app).toBe("shop");
    expect(shop.names).toEqual([
      { name: "products", range: { start: { line: 5, col: 39 }, end: { line: 5, col: 47 } } },
      { name: "product", range: { start: { line: 6, col: 62 }, end: { line: 6, col: 69 } } },
    ]);
    expect(shop.includes).toEqual([{ module: "shop.api.urls", namespace: null, app: null }]);
  });

  it("nests namespaces along includes", () => {
    expect(names({ "/p/shop/urls.py": SHOP, "/p/shop/api/urls.py": API })).toEqual([
      "shop:api:item",
      "shop:product",
      "shop:products",
    ]);
    // From the root URLconf: app namespace, instance namespace, the tuple form, and none.
    expect(
      names({ "/p/site/urls.py": ROOT, "/p/shop/urls.py": SHOP, "/p/shop/api/urls.py": API, "/p/blog/urls.py": BLOG }),
    ).toEqual([
      "blog:index",
      "home",
      "shop-v2:api:item",
      "shop-v2:product",
      "shop-v2:products",
      "shop:api:item",
      "shop:product",
      "shop:products",
    ]);
  });

  it("finds the name in reverse() and the like, also when the call starts a line above", () => {
    const line = `    return redirect("shop:product", slug=p.slug) or reverse_lazy('home')`;
    expect(urlNameAt(line, line.indexOf("shop:") + 3)).toEqual({ name: "shop:product", from: 21, to: 33 });
    expect(urlNameAt(line, line.indexOf("home"))).toMatchObject({ name: "home" });
    const split = `url = reverse(\n    "shop:product",\n)`;
    expect(urlNameAt(split, split.indexOf("product"))).toMatchObject({ name: "shop:product" });
    expect(urlNameAt(`render(request, "shop/list.html")`, 20)).toBeNull();
    expect(urlNameAt(`reverse("a", args=["b"])`, 20)).toBeNull();
  });

  it("navigates to the pattern and completes the names", async () => {
    ipc.files = { "/p/shop/urls.py": SHOP };
    const text = `x = 1\nurl = reverse(\n    "shop:product")`;
    const match = await urlNavigation(text.slice(4), 4, text.indexOf("product"));
    expect(match).toMatchObject({
      from: text.indexOf("shop:"),
      targets: [{ path: "/p/shop/urls.py", name: "shop:product" }],
    });
    const state = EditorState.create({ doc: `reverse("shop:pr` });
    const result = await urlCompletion(new CompletionContext(state, state.doc.length, true));
    expect(result?.from).toBe(9);
    expect(result?.options.map((o) => o.label)).toEqual(["shop:products", "shop:product"]);
  });

  it("asks the index again when it had no urls.py yet, and drops navigation's hits when names change", async () => {
    ipc.files = {};
    expect(await projectUrlNames()).toEqual([]);
    await Promise.resolve();
    ipc.files = { "/p/shop/urls.py": SHOP };
    expect((await projectUrlNames()).map((u) => u.name)).toContain("shop:product");
    forgetUrlNames();
    expect(ipc.invalidate).toHaveBeenCalled();
  });
});
