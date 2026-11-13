# Semantic Java usages and configuration navigation

Spring YAML / properties navigation is described in [CONFIGURATION.md](CONFIGURATION.md).

The app-owned OSGi command `openidea.java.usages` returns `{location, kind, access}`.
`kind` retains field/getter/setter/unknown identity for compatibility. Optional
`access` is read/write/readWrite/unknown. Missing access metadata is unknown;
old servers and ordinary LSP locations remain visible under either filter.
An absent or failing extension command uses standard LSP references, without access
classification or toolbar controls. This includes errors during scope widening.
The Rust bridge logs the failure once per project session. Cancelled requests and
changed source documents remain cancelled and do not start a fallback search.
No global `includeAccessors` preference is changed.

An optional fifth argument `"sources"` restricts the search to the workspace's
source folders (no dependency jars, no JDK). A library method can have thousands of
usages in those, which take seconds to search. Find Usages searches the sources alone
(Project Files) unless asked for Project and Libraries; then it shows the sources' usages
first and runs the full search after it. Rows in library classes (`jdt:` URIs) carry their
line as `text`, from the contents the client would request for the class, so the client
need not fetch thousands of class files to show them.

`openidea.workspace.coveredFiles([candidateUri, ...])` returns candidate URIs already
covered by the current JDT source search scope. It checks imported compilation units,
classpath inclusion/exclusion rules and test-source policy; it does not infer coverage
from directory names. References, rename and incoming calls leave those files closed
and only widen with the remaining candidates. A missing or failing command retains
widening. The result is query-local, so imports and classpath changes need no cache invalidation.

`openidea.workspace.coveredRoots()` returns the URIs of source folders whose Java files the search
scope covers all: no exclusion patterns, no inclusion pattern other than Maven's `**/*.java`, and
enclosed by the test-source policy. The client does not read the files under them when it looks
for candidates, which on a large project took most of a cached search's time.

## Search plan and access semantics

For source fields on the verified JDT LS implementation, a single plan merges
field, native getter/setter, native builder and explicit Lombok Accessors targets.
Targets are deduplicated by JDT element identity before search, retaining native
search scope and ranges. Builder results remain unknown. The optimized native
plan is guarded by SHA-256 of ReferencesHandler.class:
`31ff5a10c7d69d58c6a9b619ef17e3ec41b11b545751ba428618a76cc1341064`
(JDT LS 1.63.0.202610191322). On that version, non-field and library/decompiled
selections resolve their target as `ReferencesHandler.findReferences` does, and every
search replicates `ReferencesHandler.search` with one difference: a class file whose
decompiled source fails to parse loses only its own matches (logged), where the server
throws and fails the whole search after searching most dependencies. Different
implementations retain native discovery plus deduplicated category searches. This
conservative fallback preserves coverage when the server changes; it does not promise
the same speedup or fault isolation on unverified versions.

SearchEngine resolves exact targets. A query-local syntax AST per referenced source
file supplies expression context without another reference search: simple field
assignment is write, compound assignment/increment is readWrite, ordinary field
use is read. Writing an array element or a receiver's member reads the array or
receiver field. Getter/setter call expressions are read/write respectively.
Method references, declarations, unavailable/changed source, and unclassified
search targets remain unknown. No call text or get/set prefix classifies a usage.
Explicit `@Accessors` is resolved to JDT method signatures as in the prior bundle.

For larger result sets, a query-local AST range index avoids repeating NodeFinder
traversals. It indexes only requested exact AST ranges and verified invocation
selector-to-call-end spans; duplicate, recovered, malformed or uncontained ranges
fall back to NodeFinder. Method references do not get invocation aliases. Source
snapshot checks remain per result, and the index is discarded after the query.

Answers are cached by their search targets (JDT handles, kinds, declarations), the scope and the
search settings, together with a digest of the editors' unsaved contents, until a Java element
delta reports a change to the sources, a compilation unit or a classpath (`UsageCache`). Opening
or closing an editor and decompiled library classes' private working copies do not invalidate
them. A usage count and the usages shown when it is clicked, or the same search run again, need
no second search, and concurrent requests for the same targets share one. There is no
binding-resolution shortcut.

Popup and Find share persisted read/write toolbar switches. Both initially show;
turning the last one off automatically enables the other. Unknown and readWrite
entries survive both single-access modes. Filtered-out selections are not previewed.
Exact original ranges and access metadata survive transfer to Find. Closing or
superseding a popup request prevents late responses from reopening it.

The interaction and primary-field/secondary-accessor design were checked against
[JetBrains IntelliJ Community e992ff4](https://github.com/JetBrains/intellij-community/tree/e992ff4750b4c36afe2caadfa8b191a8f36fb7a2):
`LombokFieldFindUsagesHandlerFactory`, `LombokReadWriteAccessDetector`,
`UsageFilteringRuleStateRWAware`, `ReadAccessFilteringRule`, and
`WriteAccessFilteringRule`. This implementation does not copy those sources and
is not a claim of full IntelliJ feature parity.

## Rebuild and delivery

The checked-in jar is embedded by ide-sdk `include_bytes!`, installed as
`java-usages-1.13.0.jar`, and added alongside existing initialization bundles.
Users need no compiler, Maven or Python. Manifest/install version must change
when replacing the bundle because OSGi caches bundles.

Build dependency: [JDT LS 1.63.0 build 202610191322](https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz).
Use its shipped ECJ and plugin jars, with Java 25; emitted bytecode targets Java 21.
The build uses sorted inputs and fixed zip timestamps and does not resolve Maven
artifacts. Check the extracted distribution against `build-dependencies.sha256`
from its root (`sha256sum -c /path/to/build-dependencies.sha256`). Build twice
and compare SHA-256. The prior 1.1.1 output was
`1e569939cba22c7db6e2c9b53de2a4c10ccaabe762a51427119a04af3d974ae4`.
Version 1.2.0 adds the configuration command; its reproducible SHA-256 is
`9140f1d2ecf27eadfe66b40a17daa18a08a65927ebef79456ba55d486ce5eeba`.
Version 1.2.1 keeps the configuration snapshot across editor open/close, saves of
unrelated content and non-Java resource changes; its reproducible SHA-256 is
`cbae3e3a0bcf2818b4cc9d98998bd9b81f92e1ae7803dc757134485f9776a4e1`.
Version 1.3.0 adds the class-hierarchy refactoring commands; its reproducible SHA-256 is
`cca4cc385ace286111730d2a6164333b8958d74d69631548eadca8863255c24a`.
Version 1.4.0 adds `openidea.java.implementations` (Go to Implementation in the workspace's
source folders, before the standard request that also searches every dependency jar); its
reproducible SHA-256 is `d7601493eda846811b4bb8bfe7f3d56e3234a45e663648210db3937cebc770a5`.
Version 1.5.0 answers `{locations, complete}`: `complete` when the type is declared in the sources
(no dependency implements it), otherwise the app also runs the standard request and adds the
dependencies' implementations after the first ones. The search also covers the project's Kotlin
classes attached by the Kotlin bridge; its reproducible SHA-256 is
`7588748c2797f9da2beb209714a75c29b4e31b155f095329bfb7e399d807c20a`.
Version 1.6.0 adds `openidea.java.configuration.warmup`, which builds configuration indexes in a
low-priority background job after import, and builds them under cancellable per-project locks
instead of one global lock; its reproducible SHA-256 is
`33cfa1bb8489247ffeb6fc8249966c8a2955b7b2858c8169a70486eb70ade696`.
Version 1.7.0 adds the `"sources"` scope to `openidea.java.usages`, searches each class
file's decompiled source on its own and returns the line (`text`) of each usage in a library
class; its reproducible SHA-256 is
`56d35619d5be937b028ac143ba748365a66a74c803bc112e4788a7dce98b44fc`.
Version 1.8.0 keeps each dependency JAR's configuration metadata across rebuilds of the
configuration index (until the JAR or the project's classpath changes), so a source change no
longer resolves every Spring Boot property again; its reproducible SHA-256 is
`728ab33b5e01fa5e496818f25ddbc487458a92339026899b0e22abda5adfd67b`.

Version 1.9.0 adds the analysis-scope command to avoid redundant semantic queries;
its reproducible SHA-256 is
`ae04182d6a86dfdd6f6befaaeb28907fd9e4c022ceedb445f0b32ea917dca379`.
Version 1.12.0 caches usages answers until the Java model or an unsaved edit changes and adds
`openidea.workspace.coveredRoots`; its reproducible SHA-256 is
`c1bd28d7b956cb64af3e936aac0553413a5dc5fd373a043ddba003009e0ea783`.

```sh
export PATH=/path/to/jdk25/bin:$PATH
python3 java/java-usages/build.py /path/to/jdtls
```

## Manual upgrades

Rebuilding on a JDT LS upgrade is manual. Updating JDT LS or compiling the app does
not rebuild this jar. A maintainer must:

1. Obtain the intended JDT LS distribution and verify its provenance and plugin hashes.
   Update `build-dependencies.sha256` for the reviewed distribution.
2. Review the internal APIs listed below. Check `ReferencesHandler.class` against
   the native-plan fingerprint; update the guarded plan only after reviewing changes.
3. Bump the bundle version in `MANIFEST.MF` and the installed filename in
   `crates/ide-sdk/src/java.rs` so OSGi does not reuse the old cached bundle.
4. Run `build.py` with that distribution and JDK 25 as shown above. Build twice and
   compare hashes, then run both real-server harnesses and the desktop checks below.
5. Commit the reviewed source, dependency inventory, version changes and rebuilt jar
   together. Test the current and newly supported JDT LS versions before release.

## Real server verification

```sh
python3 java/java-usages/tests/verify.py /path/to/jdtls /path/to/lombok.jar
python3 java/java-usages/tests/read-write.py /path/to/jdtls /path/to/lombok.jar > /tmp/read-write.json
OPENIDEA_USAGES_INDEX_STRESS=1 python3 java/java-usages/tests/read-write.py /path/to/jdtls /path/to/lombok.jar > /tmp/read-write-indexed.json
python3 java/java-usages/tests/hierarchy.py /path/to/jdtls
python3 java/java-usages/tests/implementations.py /path/to/jdtls
```

The harnesses select the JDT LS configuration for the current platform. The first
verifies category coverage, standard-reference inclusion, boolean/fluent/prefix/chain
naming, overloads, inheritance and includeAccessors=false. The second checks
structural read/write cases, interface and inherited calls, nested same-line calls,
method references, receiver/array reads and a real cancellation response (`-32800`).

Use the actual desktop app to check read/write toggles, mutual toggle behavior,
Find transfer, persistence and unfiltered non-Java counts with the same fixture.

`hierarchy.py` runs Pull Members Up and Push Members Down: member and destination
listing, moving, declaring abstract, pulling up to an interface, conflicts reported
before any change, and a class without supertypes. Each edit is applied to a copy of
the fixture and compiled with javac.

## Class-hierarchy refactorings

`openidea.java.hierarchy.members(uri, line, column, kind)` describes the class at the
position for `kind` `pullUp` or `pushDown`: its movable members (handle id, label,
kind, preselected, can be declared abstract) and the destination supertypes, or the
direct subtypes the members are pushed into. A position on a member preselects it.
`openidea.java.hierarchy.refactor(uri, line, column, kind, target, choices)` runs
JDT's `PullUpRefactoringProcessor` / `PushDownRefactoringProcessor` with the chosen
`{id, abstract}` members and returns `{problems, edit}`. Nothing is applied by the
server; the app shows the problems, then applies the edit as one undoable change.
A method pulled up to an interface is always declared there, as in JDT's wizard.
Either command answers `{refused: reason}` when the position can't be refactored.

## Review and manual reproduction

See [the English reproduction guide](tests/REPRODUCE.md) for a small Java/Lombok
fixture, before/after behavior and desktop verification steps.

## Internal API compatibility

This is an app-owned JDT LS extension, not a standard LSP feature. It uses:

- `org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler` and the
  `org.eclipse.jdt.ls.core.delegateCommandHandler` extension point.
- `ReferencesHandler.findReferences` and `search`; the optimized plan also
  reflects its private `getBuilderName(IField)` on the fingerprinted version.
- `JavaLanguageServerPlugin.getPreferencesManager` and the returned preference
  objects (`isIncludeAccessors`).
- `JDTUtils.resolveTypeRoot`, `findElementAtSelection`.
- `org.eclipse.jdt.internal.corext.codemanipulation.GetterSetterUtil`.
- `org.eclipse.jdt.internal.corext.refactoring.structure.PullUpRefactoringProcessor`,
  `PushDownRefactoringProcessor`, `RefactoringAvailabilityTesterCore`, `JdtFlags`,
  `JavaElementLabelsCore`, `PreferenceManager.getCodeGenerationSettings`,
  `JsonRpcHelpers.toOffset`, `JDTUtils.resolveCompilationUnit` and
  `ChangeUtil.convertToWorkspaceEdit`.
- Public JDT model/DOM APIs for exact target identity and source-expression context.

The fingerprint protects native target discovery, not all binary compatibility.
A server update that breaks linkage or command execution falls back to standard
references in the Rust bridge. Results remain visible without classification.
Rebuild and run the real-server and desktop tests when changing the distribution.
The current read/write implementation was tested on JDT LS 1.63.0.202610191322
with Lombok 1.18.48 and Java 25. It is not certified for every milestone.

## Boundaries

- `lombok.config`-only naming, unusual generic spellings, custom capitalization or
  ambiguous annotations retain the prior limitations; no speculative mapping.
- Method references are conservatively unknown rather than asserted immediate reads/writes.
- Constructor initialization is outside this product change.
- Internal JDT APIs still require compatibility testing on updates; guarded native
  planning is intentionally limited to a verified implementation.
- Packaged desktop/macOS WebKit and the user's own project require separate testing.
