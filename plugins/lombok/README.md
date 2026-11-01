# Lombok agent for JDT LS

`lombok-1.18.48-openidea.1.jar` is the app-provided Java agent for JDT LS. It includes
[projectlombok/lombok#4059](https://github.com/projectlombok/lombok/pull/4059), which restores
`lombok.config` lookup after Equinox removed `getModuleClassLoader(boolean)`.

The jar is embedded by `ide-tools`, so every platform receives the same bytes without a download.
Both Java server startup and launch diagnostics obtain it through `managed_bundle`. Tool detection
reports the same version and path, replacing older IDE-installed official agents automatically.
An explicit user `-javaagent` still takes precedence. Project Maven/Gradle dependencies are unchanged.
The filename includes the patch version because JDT LS workspace keys include the agent path;
changing agents must rebuild classes produced by the old agent. Old jars remain for running windows.

Replace this temporary bundle with an official Maven Central release once that release includes
#4059. Restore the registry's Maven Central install method and remove the embedded jar. Keep the
workspace migration test when changing its path.

## Provenance and build

- Repository: https://github.com/projectlombok/lombok
- Base tag: `v1.18.48` (`b48657c83ce44d027984f539bd36048293ce5e8e`).
- Cherry-picked commits from PR #4059, in order:
  - `2d535482a913de46c27d06c5b0b294918ede3f9c`
  - `3098f4dd78b5349c2f382e7310e64db810dd380b`
- Upstream version: `1.18.48`; `openidea.1` identifies this distribution of the patched agent.
  Upstream's own `java -jar ... --version` still reports `1.18.48`.
- SHA-256: `10f5cd1a32b946d3ff1c075735b94f35fffdbac11dea2be29d24dbf591dd51a4`
- License: [MIT, including bundled component notices](LICENSE), also retained inside the jar.
- Build environment: macOS arm64, OpenJDK 23.0.1, Apache Ant 1.10.15, upstream Ivy setup.

Build using the upstream Ant entry point described in its contributing guide:

```sh
git clone https://github.com/projectlombok/lombok.git
cd lombok
git checkout -b openidea-1.18.48 v1.18.48
git fetch https://github.com/chagong/lombok.git fix-equinox-bundle-wiring
git cherry-pick 2d535482a913de46c27d06c5b0b294918ede3f9c 3098f4dd78b5349c2f382e7310e64db810dd380b
ant dist
cp dist/lombok.jar /path/to/openidea/plugins/lombok/lombok-1.18.48-openidea.1.jar
```

The changelog context conflicts because the first commit adds a release-note line under the
older development heading and the second removes it. Resolve mechanically by adding then removing
only that line, retaining the complete v1.18.48 changelog. The final source diff from v1.18.48 changes
only `src/eclipseAgent/lombok/launch/PatchFixesHider.java`, `test/core/src/lombok/TestEclipse.java`,
and `test/core/src/lombok/launch/PatchFixesHiderTest.java`; no other Java source changes were made.
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

Windows and Linux runtime validation has not been performed. Rust tests cover source selection
for both supported architectures on all three OS variants, offline provisioning, corruption
repair, concurrent windows, explicit user overrides, and JDT LS workspace migration.
