package com.example.app;

import com.example.core.Greeter;
import org.apache.commons.lang3.StringUtils;

public class Main {
    public static void main(String[] args) {
        Greeter greeter = new Greeter();
        String message = greeter.greet(StringUtils.capitalize("world"));
        System.out.println(message);
    }
}
