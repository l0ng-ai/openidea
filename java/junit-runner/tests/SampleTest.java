package sample;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class SampleTest {
    @Test
    void passes() {
        System.out.println("hello [ünï]");
    }

    @Test
    void fails() {
        assertEquals(1, 2, "it's wrong");
    }

    @Test
    @Disabled
    void disabled() {}

    @Test
    void aborted() {
        assumeTrue(false);
    }

    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    void parameterized(int n) {
        assertEquals(1, n);
    }

    @Nested
    class Inner {
        @Test
        void nested() {}
    }
}
