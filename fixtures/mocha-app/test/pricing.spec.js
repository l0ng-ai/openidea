import assert from "node:assert/strict";
import { bulkDiscount, withTax } from "../src/pricing.js";

describe("pricing", function () {
  describe("withTax", function () {
    it("adds the rate", function () {
      assert.equal(withTax(100, 0.2), 120);
    });

    it("rejects a negative rate", function () {
      assert.throws(() => withTax(100, -0.1), RangeError);
    });
  });

  describe("bulkDiscount", function () {
    it("has no discount for a few items", function () {
      assert.equal(bulkDiscount(3), 0);
    });

    it("discounts large orders", function () {
      assert.equal(bulkDiscount(250), 0.15);
    });
  });

  it("intentionally fails (set OPENIDEA_FAIL=1)", function () {
    if (!process.env.OPENIDEA_FAIL) this.skip();
    assert.equal(withTax(10, 0.1), 11.5);
  });
});
