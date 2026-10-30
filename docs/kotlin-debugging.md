# Kotlin debugging

Kotlin Application configurations use the official `fwcd/kotlin-debug-adapter`
release, installed through Settings > Language Servers or the missing-debugger
prompt. A module containing `.kt` files under `src` uses this adapter for both
Application launch and Maven/Gradle JDWP attach, including mixed Java/Kotlin
modules. Pure Java modules keep `java-debug`.

The adapter runs on the language-server JDK (11+). The application runs on its
resolved project JDK, with the classpath, VM arguments, program arguments and
environment from its run configuration.

## Source paths

The adapter infers JVM class names from source paths. OpenIDEA creates a temporary,
package-aligned source mirror outside the project and supplies it as the adapter's
`projectRoot`. For example, `src/main/kotlin/Main.kt` declaring `package org.example`
gets an external `src/main/kotlin/org/example/Main.kt` alias. Breakpoints go through
that alias; stack frames and event paths map back to the original editor file.
Source sets have separate mirror roots. Where file symlinks are unavailable,
OpenIDEA copies sources and refreshes the copies on editor saves.

Restart debugging after changing a package or source root. The upstream adapter's
path-based resolver does not support renamed Kotlin facades (`@file:JvmName`), or
packages containing a literal `java` or `kotlin` component. Selecting the correct
main class does not remove those breakpoint limitations.

The Kotlin Application launcher currently passes the classpath directly, without
Java's large-command-line shortening, and decodes application output as UTF-8.
Very large classpaths and non-UTF-8 application output remain limitations; Windows
runtime behavior has not been verified.

## Startup ordering

OpenIDEA starts Kotlin applications with JDWP `suspend=y` and attaches the adapter.
It waits for each `setBreakpoints` response before sending `configurationDone`.
Adapter 0.4.4 never completes the `configurationDone` response, so OpenIDEA sends
that request without awaiting its response.

The official adapter can resume the VMStart event before installing its breakpoint
hooks and DAP listeners. A session-owned loopback JDWP relay holds VM and thread
resume commands until the successful DAP attach response, which follows listener
installation. Other JDWP requests and replies continue during setup. Attach failure
or session shutdown closes the relay and kills any JVM launched by OpenIDEA. No
adapter patch or timed startup sleep is used. An already-running external JVM must
be started with `suspend=y` to preserve its earliest breakpoints.

## Verification

`cargo test -p ide-dap --lib` covers relay ordering, fragmented packets, cleanup,
source mapping, and the adapter's missing configuration response. The ignored
`kotlin_official_release_ten_no_delay_runs` test exercises the real DAP client ten
times with an official adapter and a compiled reporter fixture. Set
`KOTLIN_PROBE_CONFIG` to a LaunchConfig JSON file and `KOTLIN_PROBE_ADAPTER` to the
release executable, then run:

```sh
cargo test -p ide-dap kotlin_official_release_ten_no_delay_runs -- --ignored --nocapture
```

The fixture is `src/main/kotlin/Main.kt`, with `package org.example`, a `for (i in
0..3)` loop at line 5 and `println(i)` at line 6, without any startup delay. Each run
must hit line 6, expose `i = 0`, step to line 5, and stop its session.
