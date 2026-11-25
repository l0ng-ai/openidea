# Java build

The IDE's own build of Maven and Gradle modules (`ide_build::jbuild`). The jar holds two parts:

- `ai.openidea.javac.Server` (`src/`): a resident javac. OpenIDEA starts one per JDK (and
  `.mvn/jvm.config`) as `java -cp openidea-java-build.jar ai.openidea.javac.Server` and keeps it
  running between builds. It reads one JSON request per line on stdin and answers on stdout:

  | Request                                                                  | Meaning                                         |
  | ------------------------------------------------------------------------ | ----------------------------------------------- |
  | `{"id":1,"op":"compile","options":[…],"sources":[…],"encoding":"UTF-8"}` | Compile with javac (`ToolProvider`), in process |
  | `{"op":"cancel","id":1}`                                                 | Stop that compilation at javac's next phase     |
  | `{"op":"exit"}`                                                          | Finish the queued requests, then exit           |

  Replies carry the request's `id`: `diagnostic` (1-based line, 0-based UTF-16 column),
  `output` (a class file and the source it came from), `generated` (a source an annotation
  processor wrote), `output-text`, then `done`. `ready` and `fatal` concern the server.

- `ai.openidea.javac.maven.BuildModel` (`maven/`): a Maven core extension, loaded with
  `-Dmaven.ext.class.path`. With `-Dopenidea.build.output=<dir>` it redirects every project's
  output to `<dir>/<groupId>.<artifactId>/classes|test-classes`, and resolves reactor
  projects to those folders. With `-Dopenidea.build.model=<file>` it writes, after the build,
  each project's source roots, classpaths, resources and the configuration maven-compiler-plugin's
  mojos get (including the resolved `annotationProcessorPaths`), as JSON.

OpenIDEA runs `mvn process-resources resources:testResources` with the extension when the POMs,
settings or generator inputs change, then compiles the launch's modules with the server.

Gradle builds get the same model from an init script instead
(`crates/ide-build/src/jbuild/gradle-build.init.gradle`, task `openideaBuildModel`, with
`-Popenidea.build.output` and `-Popenidea.build.model`), when Settings › Gradle › Build and run
using is set to the IDE.

The jar is committed and embedded by `ide-sdk` (`java_build_jar`). It is built with `--release 8`
against Maven 3.9.11, whose files `build-dependencies.sha256` pins. Rebuild it after changing
the source:

```sh
JAVA_HOME=<JDK 11+> python3 build.py <apache-maven-3.9.11 folder>
```
