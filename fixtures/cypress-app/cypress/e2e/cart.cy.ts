import { discount, subtotal, withTax, type Item } from "../../src/cart";

const mug: Item = { sku: "mug", price: 12, quantity: 2 };
const lamp: Item = { sku: "lamp", price: 40, quantity: 1 };

describe("cart", () => {
  it("adds up the items", () => {
    cy.wrap(subtotal([mug, lamp])).should("eq", 64);
  });

  context("totals", () => {
    it("adds the tax", () => {
      cy.wrap(withTax(64)).should("eq", 70.4);
    });

    // Fails on purpose with `--expose fail=1`.
    it("rounds to cents", () => {
      cy.wrap(withTax(Cypress.expose("fail") ? 1.01 : 1)).should("eq", 1.1);
    });
  });

  it.skip("keeps the cart between visits", () => {});
});

describe("discounts", () => {
  it("halves the total", () => {
    expect(discount(64, "HALF")).to.equal(32);
  });

  it("rejects unknown codes", () => {
    expect(() => discount(64, "NOPE")).to.throw("unknown code");
  });
});
