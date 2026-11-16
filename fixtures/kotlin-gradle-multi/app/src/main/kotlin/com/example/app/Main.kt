package com.example.app

import com.example.lib.Greeter
import org.apache.commons.lang3.StringUtils

fun main() {
    val greeter = Greeter()
    val message = greeter.greet(StringUtils.capitalize("world"))
    println(message)
}
