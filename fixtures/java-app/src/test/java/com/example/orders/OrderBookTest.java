package com.example.orders;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

class OrderBookTest {
    @Test
    void sumsRevenueOverAllOrders() {
        OrderBook book = new OrderBook();
        book.place("alice", "Keyboard", 2, 1000);
        book.place("bob", "Mouse", 1, 500);
        assertEquals(2500, book.revenueCents());
        assertEquals(1, book.byCustomer("bob").size());
    }

    @Test
    void rejectsEmptyOrders() {
        assertThrows(IllegalArgumentException.class, () -> new Order("alice", "Keyboard", 0, 1000));
    }

    @Test
    @EnabledIfSystemProperty(named = "openidea.fail", matches = "true")
    void intentionallyFails() {
        assertEquals(1, new OrderBook().size(), "QA: an intentionally failing test");
    }
}
