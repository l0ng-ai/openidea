package sample;

import static org.junit.Assert.assertEquals;
import static org.junit.Assume.assumeTrue;

import java.util.Arrays;
import java.util.Collection;
import org.junit.BeforeClass;
import org.junit.Ignore;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

public class Junit4SampleTest {
    @Test
    public void passes() {
        System.out.println("hello [ünï]");
    }

    @Test
    public void fails() {
        assertEquals("it's wrong", 1, 2);
    }

    @Test
    @Ignore("later")
    public void ignored() {}

    @Test
    public void assumed() {
        assumeTrue(false);
    }

    @RunWith(Parameterized.class)
    public static class Params {
        @Parameterized.Parameters
        public static Collection<Object[]> data() {
            return Arrays.asList(new Object[][] {{1}, {2}});
        }

        private final int n;

        public Params(int n) {
            this.n = n;
        }

        @Test
        public void parameterized() {
            assertEquals(1, n);
        }

        @Test
        public void other() {}
    }

    public static class Broken {
        @BeforeClass
        public static void setUp() {
            throw new IllegalStateException("no database");
        }

        @Test
        public void never() {}
    }
}
