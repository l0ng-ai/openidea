# Kotlin binary bridge

App-owned source, licensed under this repository's Apache-2.0 license. The jar
contains no third-party implementation classes. JDT LS and Maven supply their
respective APIs at runtime.

`KotlinLibraries` is a JDT LS delegate command. `openidea.kotlin.replace` takes
one complete array of `{projectUri, libraries: [{path, test}]}` objects and returns
the number of changed projects. Paths name fully published, immutable directories.
An empty array withdraws all owned libraries. Only library entries carrying
`ai.openidea.kotlin=true` are removed; all other `IClasspathEntry` objects are
retained, including containers, access rules, attributes and project references.
A Java model listener restores the desired snapshot after Maven reimport.

`IsolatedOutput` is a Java 8 Maven lifecycle participant, activated only in the
private editor build via `-Dmaven.ext.class.path=<jar>` and
`-Dopenidea.kotlin.staging=<absolute-directory>`. It redirects reactor output
before lifecycle planning and records Maven's resolved dependency closure after
a successful build. The host uses the project's Maven lifecycle/configuration,
then publishes only classes whose actual `SourceFile` attribute ends in `.kt`,
plus Kotlin module metadata. Java output is not bridged. Main/test Kotlin APIs and
same-reactor consumers are covered; Precise Kotlin
source navigation, unsaved analysis and refactoring are outside this bridge.

The host debounces saved/source/configuration changes, withdraws stale libraries,
cancels superseded process groups, and attaches a new immutable version only
after successful compilation. Compiler failures appear under the
`kotlin-bridge` Problems source and in a notification. Run/Debug preparation is
independent of this editor build.

## Build

Built against JDT LS 1.63.0 and Maven 3.9.11, using their installed API jars.
`build-dependencies.sha256` pins all build inputs. The build refuses different
inputs; `--record-dependencies` is an explicit maintainer action when updating
those dependencies. Compilation uses the JDT batch compiler with Java 21 target
for the JDT command and Java 8 target for the Maven participant. Use Java 25 to
run the build compiler. Archive order and timestamps are deterministic.

```sh
python3 plugins/kotlin-bridge/build.py /path/to/jdtls /path/to/maven
shasum -a 256 plugins/kotlin-bridge/openidea-kotlin-bridge.jar
```

Committed jar SHA-256:
`4bc0549bcfbb4d682156756ff6e378a08c3404eff215aa2fbff3d8c03eec576d`.

The SDK embeds this jar with `include_bytes!`, writes it atomically into the app
data directory, and includes it in JDT LS initialization bundles.

## Integration regression

```sh
# `java` on PATH must satisfy JDT LS; JAVA_HOME selects Maven's project JDK.
JAVA_HOME=/path/to/project/jdk python3 plugins/kotlin-bridge/tests/verify.py /path/to/jdtls
```

Requires Maven on PATH and access to Kotlin 2.0.10 and the fixture's Maven
plugins (or their existing local cache). The test creates its own projects,
workspace, bundle copy and JDT process. It checks baseline errors, single/reactor
resolution, SMS/member completion, binary definition locations, preservation of
unowned entries, reimport, API changes, rename/delete/compile failure withdrawal
and repair. Evidence and protocol transcripts are written to a printed temporary
directory. Only the spawned JDT process is terminated.
