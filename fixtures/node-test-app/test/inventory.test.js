import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Inventory } from "../src/inventory.js";

describe("inventory", () => {
  it("counts received stock", () => {
    assert.equal(new Inventory().receive("mug", 3).receive("mug", 2).count("mug"), 5);
  });

  describe("shipping", () => {
    it("takes items out of stock", () => {
      assert.equal(new Inventory().receive("mug", 3).ship("mug", 2).count("mug"), 1);
    });

    it("refuses more than is in stock", () => {
      assert.throws(() => new Inventory().ship("mug", 1), /not enough mug/);
    });
  });

  it("intentionally fails (set OPENIDEA_FAIL=1)", { skip: !process.env.OPENIDEA_FAIL }, () => {
    assert.equal(new Inventory().receive("mug", 1).count("mug"), 2);
  });
});

it("rejects non-positive quantities", () => {
  assert.throws(() => new Inventory().receive("mug", 0), RangeError);
});
