package com.acme.orders;

/**
 * A mapper whose XML is missing on purpose: its method offers `Generate Statement
 * for …`, which creates `src/main/resources/com/acme/orders/OrderMapper.xml` (the
 * resources twin of the package folder) and writes the statement into it.
 */
public interface OrderMapper {
    Order findById(Long id);

    int deleteById(Long id);
}
