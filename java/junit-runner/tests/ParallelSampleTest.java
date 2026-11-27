package sample;

import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.RepeatedTest;

/** Many tests finishing at once when JUnit runs them in parallel. */
class ParallelSampleTest {
    @RepeatedTest(2000)
    void passes() {}

    @RepeatedTest(2000)
    void fails() {
        fail("no");
    }
}
