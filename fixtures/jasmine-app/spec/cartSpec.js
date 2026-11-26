import { addItem, total } from "../src/cart.js";

describe("cart", () => {
  describe("total", () => {
    it("is zero for an empty cart", () => {
      expect(total([])).toBe(0);
    });

    it("multiplies price by quantity", () => {
      expect(total([{ price: 2.5, quantity: 4 }])).toBe(10);
    });
  });

  describe("addItem", () => {
    it("appends the item", () => {
      expect(addItem([], { price: 1, quantity: 1 }).length).toBe(1);
    });

    it("rejects a zero quantity", () => {
      expect(() => addItem([], { price: 1, quantity: 0 })).toThrowError(RangeError);
    });
  });

  it("intentionally fails (set OPENIDEA_FAIL=1)", () => {
    if (!process.env.OPENIDEA_FAIL) pending("set OPENIDEA_FAIL=1");
    expect(total([{ price: 3, quantity: 2 }])).toBe(7);
  });
});
