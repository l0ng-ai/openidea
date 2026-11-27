import { describe, expect, it } from "vitest";
import { lookupAt, lookupOptions, modelFields, parseModels } from "./models";

const MODELS = `from django.db import models


class Stamped(models.Model):
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class Category(Stamped):
    name = models.CharField(max_length=50)
    parent = models.ForeignKey("self", null=True, on_delete=models.CASCADE)


class Coffee(Stamped):
    name: str = models.CharField(max_length=100)
    price = models.DecimalField(max_digits=6, decimal_places=2)
    category = models.ForeignKey(Category, related_name="coffees", on_delete=models.CASCADE)
    roaster = models.ForeignKey("shop.Roaster", on_delete=models.CASCADE)

    def __str__(self):
        return self.name


class Roaster(models.Model):
    name = models.CharField(max_length=50)
`;

const fields = modelFields(parseModels(MODELS));
const labels = (model: string, path: string[]) => lookupOptions(fields, model, path).map((o) => o.label);

describe("Django field lookups", () => {
  it("reads model fields, relations and inherited fields", () => {
    expect(parseModels(MODELS).find((m) => m.name === "Coffee")?.fields).toEqual([
      { name: "name", type: "CharField" },
      { name: "price", type: "DecimalField" },
      { name: "category", type: "ForeignKey", to: "Category", related: "coffees" },
      { name: "roaster", type: "ForeignKey", to: "Roaster" },
    ]);
    expect(labels("Coffee", [])).toEqual(["pk", "id", "created", "name", "price", "category", "roaster"]);
    // Reverse relations: related_name, else the model's lowercase name; "self" is the model itself.
    expect(labels("Category", [])).toEqual(["pk", "id", "created", "name", "parent", "category", "coffees"]);
    expect(labels("Roaster", [])).toContain("coffee");
  });

  it("follows relations and offers lookups after a plain field", () => {
    expect(labels("Coffee", ["category"])).toContain("parent");
    expect(labels("Coffee", ["category", "coffees", "roaster"])).toContain("name");
    expect(labels("Coffee", ["name"])).toContain("icontains");
    expect(labels("Coffee", ["created"])).toEqual(expect.arrayContaining(["year", "hour", "gte"]));
    expect(labels("Coffee", ["price"])).not.toContain("year");
    expect(labels("Coffee", ["nope"])).toEqual([]);
    expect(labels("Unknown", [])).toEqual([]);
  });

  it("finds the keyword being typed in a Model.objects query", () => {
    expect(lookupAt(`qs = Coffee.objects.filter(`)).toEqual({ model: "Coffee", path: [], word: "" });
    expect(lookupAt(`Coffee.objects.exclude(price__gt=1).filter(name="x", category__na`)).toEqual({
      model: "Coffee",
      path: ["category"],
      word: "na",
    });
    expect(lookupAt(`Coffee.objects.get(name__`)).toEqual({ model: "Coffee", path: ["name"], word: "" });
    // A value, not a keyword.
    expect(lookupAt(`Coffee.objects.filter(name=na`)).toBeNull();
    expect(lookupAt(`coffees.filter(name`)).toBeNull();
  });
});
