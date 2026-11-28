import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const ipc = vi.hoisted(() => ({ files: {} as Record<string, string> }));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  commands: {
    findFilesNamed: () => ok(Object.keys(ipc.files)),
    fsReadText: (path: string) => ok(ipc.files[path]),
  },
}));

const { forgetModels, lookupAt, lookupCompletion, lookupOptions, modelFields, parseModels, projectModels } =
  await import("./models");

const SHOP = `from django.db import models


class Stamped(models.Model):
    created = models.DateTimeField(auto_now_add=True)
    owner = models.ForeignKey("blog.Author", related_name="%(class)s_items", on_delete=models.CASCADE)

    class Meta:
        abstract = True


class Category(Stamped):
    name = models.CharField(max_length=50)
# a comment at column 0 doesn't end the class
    parent = models.ForeignKey(
        "self",
        null=True,
        on_delete=models.CASCADE,
    )


class Coffee(Stamped):
    name: str = models.CharField(max_length=100)
    price = models.DecimalField(max_digits=6, decimal_places=2)
    category = models.ForeignKey(Category, related_name="coffees", on_delete=models.CASCADE)
    tags = models.ManyToManyField("Tag", related_name="+")
    roaster = models.ForeignKey("blog.Author", related_query_name="roasted", on_delete=models.CASCADE)


class Tag(models.Model):
  label = models.CharField(max_length=10)
`;
const BLOG = `from django.db import models


class Author(models.Model):
    name = models.CharField(max_length=50)


class Tag(models.Model):
    slug = models.SlugField()
`;

const fields = modelFields([...parseModels(SHOP, "shop"), ...parseModels(BLOG, "blog")]);
const labels = (key: string, path: string[]) => lookupOptions(fields, key, path).map((o) => o.label);

describe("Django field lookups", () => {
  it("reads fields: annotated, multi-line, any indentation, past a comment at column 0", () => {
    const shop = parseModels(SHOP, "shop");
    expect(shop.map((m) => [m.key, m.abstract])).toEqual([
      ["shop.Stamped", true],
      ["shop.Category", false],
      ["shop.Coffee", false],
      ["shop.Tag", false],
    ]);
    expect(shop[1]!.fields).toEqual([
      { name: "name", type: "CharField" },
      { name: "parent", type: "ForeignKey", to: "self" },
    ]);
    expect(labels("shop.Tag", [])).toEqual(["pk", "id", "label"]);
  });

  it("offers inherited fields, <fk>_id, and reverse relations by their query name", () => {
    expect(labels("shop.Coffee", [])).toEqual([
      "pk",
      "id",
      "created",
      "owner",
      "owner_id",
      "name",
      "price",
      "category",
      "category_id",
      "tags",
      "roaster",
      "roaster_id",
    ]);
    // related_name, "%(class)s" per concrete model, related_query_name; none for "+" nor for the abstract model.
    expect(labels("shop.Category", [])).toContain("coffees");
    expect(labels("blog.Author", [])).toEqual(["pk", "id", "name", "category_items", "coffee_items", "roasted"]);
    expect(labels("shop.Tag", [])).not.toContain("coffee");
  });

  it("points a concrete parent's relations back from the parent alone (multi-table inheritance)", () => {
    const mti = modelFields(
      parseModels(
        `class User(models.Model):\n    name = models.CharField()\n\n\nclass Place(models.Model):\n    owner = models.ForeignKey(User, related_name="places", on_delete=models.CASCADE)\n    host = models.ForeignKey(User, on_delete=models.CASCADE)\n\n\nclass Restaurant(Place):\n    stars = models.IntegerField()\n`,
        "a",
      ),
    );
    expect(
      mti
        .get("a.User")!
        .filter((f) => f.type === "reverse")
        .map((f) => f.name),
    ).toEqual(["places", "place"]);
    // The child still queries the parent's fields.
    expect(lookupOptions(mti, "a.Restaurant", []).map((o) => o.label)).toContain("owner");
  });

  it("resolves models per app", () => {
    // "Tag" in shop's models is shop's own Tag, not blog's.
    expect(labels("shop.Coffee", ["tags"])).toContain("label");
    expect(labels("shop.Coffee", ["owner"])).toContain("name");
  });

  it("offers lookups after a field and after a relation", () => {
    expect(labels("shop.Coffee", ["category"])).toEqual(expect.arrayContaining(["parent", "isnull", "in", "exact"]));
    expect(labels("shop.Coffee", ["category", "coffees", "price"])).toContain("gte");
    expect(labels("shop.Coffee", ["name"])).toContain("icontains");
    expect(labels("shop.Coffee", ["created"])).toEqual(expect.arrayContaining(["year", "hour", "gte"]));
    expect(labels("shop.Coffee", ["price"])).not.toContain("year");
    expect(labels("shop.Coffee", ["nope"])).toEqual([]);
  });

  it("finds the keyword being typed in a query, Q() included", () => {
    expect(lookupAt(`qs = Coffee.objects.filter(`)).toEqual({ model: "Coffee", path: [], word: "" });
    expect(lookupAt(`Coffee.objects.exclude(Q(price__gt=1)).filter(name="x", category__na`)).toEqual({
      model: "Coffee",
      path: ["category"],
      word: "na",
    });
    expect(lookupAt(`Coffee.objects.filter(Q(name="a") | Q(tags__`)).toMatchObject({ path: ["tags"] });
    expect(lookupAt(`Coffee.objects.filter(name=F("x"), pr`)).toMatchObject({ word: "pr" });
    expect(lookupAt(`Coffee.objects.all().get(\n    name__`)).toMatchObject({ path: ["name"] });
    // A value, a string, and not a query.
    expect(lookupAt(`Coffee.objects.filter(name=na`)).toBeNull();
    expect(lookupAt(`Coffee.objects.filter(name="a, b`)).toBeNull();
    expect(lookupAt(`coffees.filter(name`)).toBeNull();
    expect(lookupAt(`print(Q(name`)).toBeNull();
  });
});

describe("project models", () => {
  beforeEach(forgetModels);

  it("asks the index again when it had no models.py yet, and completes the whole keyword", async () => {
    ipc.files = {};
    expect((await projectModels()).size).toBe(0);
    await Promise.resolve();
    ipc.files = { "/p/shop/models.py": SHOP, "/p/blog/models.py": BLOG };
    expect((await projectModels()).has("shop.Coffee")).toBe(true);
    const state = EditorState.create({ doc: `Coffee.objects.filter(category__na` });
    const result = await lookupCompletion("/p/shop/views.py")(new CompletionContext(state, state.doc.length, true));
    expect(result?.from).toBe(22);
    expect(result?.options.map((o) => o.label)).toContain("category__name");
  });
});
