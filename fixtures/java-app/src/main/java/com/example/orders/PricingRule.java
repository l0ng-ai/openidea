package com.example.orders;

/** Turns an order into the price charged for it, in cents. */
public interface PricingRule {
    long price(Order order);
}
