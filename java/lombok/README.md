# Lombok agent for JDT LS

`lombok-1.18.48-openidea.2.jar` is the app-provided Java agent for JDT LS. It includes:

- [projectlombok/lombok#4059](https://github.com/projectlombok/lombok/pull/4059), which restores
  `lombok.config` lookup after Equinox removed `getModuleClassLoader(boolean)`.
- [projectlombok/lombok#4089](https://github.com/projectlombok/lombok/pull/4089) (fixes
  lombok#4084 / #4094). ECJ 3.46.200, bundled with JDT LS 1.63, keeps a constructor's explicit or
  implicit `super()` / `this()` call as the first element of its statements. Lombok 1.18.48 wrapped
  that call in the `@SneakyThrows` try block (ECJ then fails with "Internal Error compiling …
  BlockScope cannot be cast to MethodScope" and the whole workspace build fails) and put `@NonNull`
  checks before it; constructors Lombok generates lacked the statement.

The jar is embedded by `ide-tools`, so every platform receives the same bytes without a download.
Both Java server startup and launch diagnostics obtain it through `managed_bundle`. Tool detection
reports the same version and path, replacing older IDE-installed official agents automatically.
An explicit user `-javaagent` still takes precedence. Project Maven/Gradle dependencies are unchanged.
The filename includes the patch version because JDT LS workspace keys include the agent path;
changing agents must rebuild classes produced by the old agent. Old jars remain for running windows.

Replace this temporary bundle with an official Maven Central release once that release includes
#4059 and #4089. Restore the registry's Maven Central install method and remove the embedded jar. Keep the
workspace migration test when changing its path.

## Provenance and build

- Repository: https://github.com/projectlombok/lombok
- Base tag: `v1.18.48` (`b48657c83ce44d027984f539bd36048293ce5e8e`).
- Cherry-picked commits, in order:
  - PR #4059 (`chagong/lombok` `fix-equinox-bundle-wiring`):
    - `2d535482a913de46c27d06c5b0b294918ede3f9c`
    - `3098f4dd78b5349c2f382e7310e64db810dd380b`
  - PR #4089 (`Rawi01/lombok` `eclipse-constructor-call-statement`):
    - `7832faa49b35c839088866daf865384c82cd555f`
    - `3f3a80b857a969839ab1baba12767aec4965ac32`
- Upstream version: `1.18.48`; `openidea.2` identifies this distribution of the patched agent
  (`openidea.1` had #4059 only).
  Upstream's own `java -jar ... --version` still reports `1.18.48`.
- SHA-256: `2978d8b2d55dac1bb4936ba44562bc4549931d4e71a7ebfeaebccd60bcdf7379`
- License: [MIT, including bundled component notices](LICENSE), also retained inside the jar.
- Build environment: macOS arm64, Temurin 25.0.5, Apache Ant 1.10.15, upstream Ivy setup
  (`openidea.1` was built with OpenJDK 23.0.1).

Build using the upstream Ant entry point described in its contributing guide:

```sh
git clone https://github.com/projectlombok/lombok.git
cd lombok
git checkout -b openidea-1.18.48 v1.18.48
git fetch https://github.com/chagong/lombok.git fix-equinox-bundle-wiring
git fetch https://github.com/Rawi01/lombok.git eclipse-constructor-call-statement
git cherry-pick 2d535482a913de46c27d06c5b0b294918ede3f9c 3098f4dd78b5349c2f382e7310e64db810dd380b
git cherry-pick 7832faa49b35c839088866daf865384c82cd555f 3f3a80b857a969839ab1baba12767aec4965ac32
ant dist
cp dist/lombok.jar /path/to/openidea/java/lombok/lombok-1.18.48-openidea.2.jar
```

The changelog context conflicts because the first commit adds a release-note line under the
older development heading and the second removes it. Resolve mechanically by adding then removing
only that line, retaining the complete v1.18.48 changelog (the second commit is then empty and
skipped). The #4089 commits apply cleanly. The final source diff from v1.18.48 changes
`src/eclipseAgent/lombok/launch/PatchFixesHider.java`, `test/core/src/lombok/TestEclipse.java`,
`test/core/src/lombok/launch/PatchFixesHiderTest.java` (#4059) and the Eclipse handlers
`EclipseHandlerUtil`, `HandleConstructor`, `HandleFieldNameConstants`, `HandleNonNull`,
`HandleSneakyThrows`, `HandleStandardException`, `HandleSuperBuilder`, `HandleUtilityClass` (#4089);
no other Java source changes were made.
In the build checkout, the two remote resolvers in
`buildScripts/ivysettings.xml` were reordered to try Maven Central before Eclipse staging; the
local resolver and all dependency coordinates were retained. The JVM was configured to use the
local HTTP/HTTPS proxy for downloads. Ant's timestamps mean a rebuild need not be byte-identical;
`SHA256SUMS` records the checked-in artifact and is verified by the Rust regression tests.

## Validation

A parent POM with DTO and application modules uses Lombok 1.18.46. Root `lombok.config` enables
`config.stopBubbling = true` and `lombok.accessors.chain = true`.

On macOS arm64 with JDT LS 1.63.0 / Equinox 3.25.0, server OpenJDK 25 and project JDK 21:

- Official 1.18.46 and 1.18.48 agents generated `void` setters; the following Maven incremental
  build reused the DTO classes and failed with `void cannot be dereferenced`.
- This agent passed five fresh project/workspace builds. `javap` confirmed setters returning
  the DTO class; the following Maven incremental install passed.
- Without `lombok.config`, both official 1.18.48 and patched agents built successfully and produced
  identical `javap` output, including default `void` setters.
- Upstream `PatchFixesHiderTest` passed both the standard OSGi and legacy Equinox lookup tests.

`openidea.2` (#4089) on macOS arm64, JDT LS 1.63.0-202610191322 (ECJ
`compiler.batch_3.46.200.v20261008-1115`), server Temurin 25:

- ECJ batch with the agent, compliance 17 and 25, against ECJ 3.46.200 and 3.46.100: `@SneakyThrows`
  constructors with implicit `super()`, explicit `super()` and `this()`; `@NonNull` constructor
  parameters; `@RequiredArgsConstructor` with an initialized final field, `@AllArgsConstructor`,
  `@NoArgsConstructor`, `@Builder` record, `@Value @Builder`, `@UtilityClass`. `openidea.1` failed
  with "Internal Error compiling" on 3.46.200; `openidea.2` compiled on both ECJ versions, the
  programs ran with identical output, and `@NonNull` checks run after the constructor call again.
- Real JDT LS `java/buildWorkspace(true)` of the same sources with the agent: `openidea.1` reported
  Failed with three internal errors and wrote no classes; `openidea.2` Succeeded with all classes.
- `java/java-usages/tests/verify.py` and `read-write.py` passed with `openidea.2`.

Windows and Linux runtime validation has not been performed. Rust tests cover source selection
for both supported architectures on all three OS variants, offline provisioning, corruption
repair, concurrent windows, explicit user overrides, and JDT LS workspace migration.
