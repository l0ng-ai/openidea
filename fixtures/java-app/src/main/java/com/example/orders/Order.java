package com.example.orders;

/** A customer order: a product, how many and the unit price in cents. */
public record Order(String customer, String product, int quantity, long unitPriceCents) {

    public Order {
        if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
    }

    /** The order's total in cents. */
    public long totalCents() {
        return unitPriceCents * quantity;
    }
}
