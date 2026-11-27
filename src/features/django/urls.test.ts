import { describe, expect, it } from "vitest";
import { urlNameAt, urlNames } from "./urls";

const URLS = `from django.urls import path

app_name = "shop"

urlpatterns = [
    path("", views.product_list, name="products"),
    path("products/<slug:slug>/", views.product_detail, name='product'),
]
`;

describe("URL names", () => {
  it("reads the names of a urls.py under its app_name", () => {
    expect(urlNames("/p/shop/urls.py", URLS)).toEqual([
      {
        name: "shop:products",
        path: "/p/shop/urls.py",
        range: { start: { line: 5, col: 39 }, end: { line: 5, col: 47 } },
      },
      {
        name: "shop:product",
        path: "/p/shop/urls.py",
        range: { start: { line: 6, col: 62 }, end: { line: 6, col: 69 } },
      },
    ]);
    expect(urlNames("/p/urls.py", `urlpatterns = [path("", home, name="home")]`).map((u) => u.name)).toEqual(["home"]);
  });

  it("finds the name in reverse() and the like", () => {
    const line = `    return redirect("shop:product", slug=p.slug) or reverse_lazy('home')`;
    const at = line.indexOf("shop:") + 3;
    expect(urlNameAt(line, at)).toEqual({ name: "shop:product", from: 21, to: 33 });
    expect(urlNameAt(line, line.indexOf("home"))).toMatchObject({ name: "home" });
    expect(urlNameAt(`render(request, "shop/list.html")`, 20)).toBeNull();
    expect(urlNameAt(`reverse("a", args=["b"])`, 20)).toBeNull();
  });
});
