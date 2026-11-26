export class Inventory {
  #stock = new Map();

  receive(sku, quantity) {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new RangeError("quantity must be a positive integer");
    this.#stock.set(sku, this.count(sku) + quantity);
    return this;
  }

  ship(sku, quantity) {
    // TODO: reserve stock for open orders before shipping
    if (quantity > this.count(sku)) throw new Error(`not enough ${sku} in stock`);
    this.#stock.set(sku, this.count(sku) - quantity);
    return this;
  }

  count(sku) {
    return this.#stock.get(sku) ?? 0;
  }
}

// An intentional warning: never used.
const RESTOCK_LEVEL = 5;
