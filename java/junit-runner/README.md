# JUnit runner

`ai.openidea.junit.Runner` runs the JUnit tests named by its arguments
(`com.acme.OrderTest`, `com.acme.OrderTest#method`; a method selects every overload, so
parameterized tests run too) and prints each test as the TeamCity service messages of
`src/features/run/gradleTests.gradle`, which the Run window's JVM parser already reads. It exits
with 1 when a test failed or none ran.

JUnit Platform tests run on the Platform launcher. JUnit 4 and JUnit 3 tests run on JUnit 4's own
`JUnitCore` (`Junit4Runner`) when the classpath has no JUnit Platform, or one without the Vintage
engine, so a JUnit 4 project needs nothing beyond its `junit` dependency.

OpenIDEA starts it for the gutter's JUnit tests of Maven modules (Settings › Maven › Run tests
using: OpenIDEA) as `java -ea -cp <test classpath>:<runner>[:<launcher>] ai.openidea.junit.Runner …`.
`ide_sdk::java::junit_launcher` picks `junit-platform-launcher` of the engine's version (none for
JUnit 4 alone), and `ide_build::surefire` reads the module's Surefire configuration for the JVM
(IDEA's `MavenJUnitPatcher`).

The jar is committed and embedded by `ide-sdk` (`junit_runner_jar`). Rebuild it after changing
the source, and check it against JUnit 5 and JUnit 4 with:

```sh
python3 build.py --test
python3 build.py
```
