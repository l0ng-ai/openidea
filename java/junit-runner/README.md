# JUnit Platform runner

`ai.openidea.junit.Runner` runs the JUnit Platform tests named by its arguments
(`com.acme.OrderTest`, `com.acme.OrderTest#method`; a method selects every overload, so
parameterized tests run too) and prints each test as the TeamCity service messages of
`src/features/run/gradleTests.gradle`, which the Run window's JVM parser already reads. It exits
with 1 when a test failed or none ran.

OpenIDEA starts it for the gutter's JUnit 5 tests of Maven modules (Settings › Maven › Run tests
using: OpenIDEA) as `java -ea -cp <test classpath>:<runner>:<launcher> ai.openidea.junit.Runner …`.
`ide_sdk::java::junit_launcher` picks `junit-platform-launcher` of the engine's version.

The jar is committed and embedded by `ide-sdk` (`junit_runner_jar`). Rebuild it after changing
the source, and check it against JUnit with:

```sh
python3 build.py --test
python3 build.py
```
