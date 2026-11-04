package com.example.orders;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/** Keeps the orders placed so far, in the order they were placed. */
public class OrderBook {
    private final List<Order> orders = new ArrayList<>();

    /** Places an order and returns it. */
    public Order place(String customer, String product, int quantity, long unitPriceCents) {
        Order order = new Order(customer, product, quantity, unitPriceCents);
        orders.add(order);
        return order;
    }

    public List<Order> byCustomer(String customer) {
        return orders.stream().filter(o -> o.customer().equals(customer)).toList();
    }

    public Optional<Order> largest() {
        return orders.stream().max(Comparator.comparingLong(Order::totalCents));
    }

    // TODO: discounts for repeat customers
    public long revenueCents() {
        return orders.stream().mapToLong(Order::totalCents).sum();
    }

    public int size() {
        return orders.size();
    }
}
