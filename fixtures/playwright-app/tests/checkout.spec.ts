import { expect, test } from "@playwright/test";
import { applyCoupon, shipping, subtotal, type Line } from "../src/checkout.ts";

const mug: Line = { sku: "mug", price: 12, quantity: 2 };
const lamp: Line = { sku: "lamp", price: 40, quantity: 1 };

test.describe("checkout", () => {
  test("adds up the lines", () => {
    expect(subtotal([mug, lamp])).toBe(64);
  });

  test.describe("shipping", () => {
    test("is free from 50", () => {
      expect(shipping([mug, lamp])).toBe(0);
    });

    test("is a flat rate below 50", () => {
      expect(shipping([mug])).toBe(4.99);
    });
  });

  test("intentionally fails (set OPENIDEA_FAIL=1)", () => {
    test.skip(!process.env.OPENIDEA_FAIL, "set OPENIDEA_FAIL=1");
    expect(shipping([lamp])).toBe(0);
  });
});

test.describe("coupons", () => {
  test("halves the total", () => {
    expect(applyCoupon(64, "HALF")).toBe(32);
  });

  test("rejects unknown codes", () => {
    expect(() => applyCoupon(64, "NOPE")).toThrow("unknown coupon");
  });
});
