package com.example.orders;

/** Takes a percentage off orders of at least {@code minQuantity} items. */
public class BulkDiscount extends ListPrice {
    private final int minQuantity;
    private final int percent;

    public BulkDiscount(int minQuantity, int percent) {
        this.minQuantity = minQuantity;
        this.percent = percent;
    }

    @Override
    public long price(Order order) {
        long list = super.price(order);
        return order.quantity() >= minQuantity ? list * (100 - percent) / 100 : list;
    }
}
