export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function addItem(items, item) {
  if (item.quantity <= 0) throw new RangeError("quantity must be positive");
  return [...items, item];
}

// An intentional warning: never used.
const MAX_ITEMS = 50;
