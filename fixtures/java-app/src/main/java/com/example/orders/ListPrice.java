package com.example.orders;

/** Charges the order's total. */
public class ListPrice implements PricingRule {
    @Override
    public long price(Order order) {
        return order.totalCents();
    }
}
