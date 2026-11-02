# Semantic Java usages

The app-owned OSGi command `openidea.java.usages` returns `{location, kind, access}`.
`kind` retains field/getter/setter/unknown identity for compatibility. Optional
`access` is read/write/readWrite/unknown. Missing access metadata is unknown;
old servers and ordinary LSP locations remain visible under either filter.
An absent or failing extension command uses standard LSP references, without access
classification or toolbar controls. This includes errors during scope widening.
The Rust bridge logs the failure once per project session. Cancelled requests and
changed source documents remain cancelled and do not start a fallback search.
No global `includeAccessors` preference is changed.

## Search plan and access semantics

For source fields on the verified JDT LS implementation, a single plan merges
field, native getter/setter, native builder and explicit Lombok Accessors targets.
Targets are deduplicated by JDT element identity before search, retaining native
search scope and ranges. Builder results remain unknown. The optimized native
plan is guarded by SHA-256 of ReferencesHandler.class:
`31ff5a10c7d69d58c6a9b619ef17e3ec41b11b545751ba428618a76cc1341064`
(JDT LS 1.63.0.202610191322). Different implementations, non-field selections and
library/decompiled selections retain native discovery plus deduplicated category
searches. This conservative fallback preserves coverage when the server changes;
it does not promise the same speedup on unverified versions.

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
There is no cross-request cache or binding-resolution shortcut.

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
`java-usages-1.1.1.jar`, and added alongside existing initialization bundles.
Users need no compiler, Maven or Python. Manifest/install version must change
when replacing the bundle because OSGi caches bundles.

Build dependency: [JDT LS 1.63.0 build 202610191322](https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz).
Use its shipped ECJ and plugin jars, with Java 25; emitted bytecode targets Java 21.
The build uses sorted inputs and fixed zip timestamps and does not resolve Maven
artifacts. Check the extracted distribution against `build-dependencies.sha256`
from its root (`sha256sum -c /path/to/build-dependencies.sha256`). Build twice
and compare SHA-256. The 1.1.1 output is
`1e569939cba22c7db6e2c9b53de2a4c10ccaabe762a51427119a04af3d974ae4`.

```sh
export PATH=/path/to/jdk25/bin:$PATH
python3 plugins/java-usages/build.py /path/to/jdtls
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
python3 plugins/java-usages/tests/verify.py /path/to/jdtls /path/to/lombok.jar
python3 plugins/java-usages/tests/read-write.py /path/to/jdtls /path/to/lombok.jar > /tmp/read-write.json
OPENIDEA_USAGES_INDEX_STRESS=1 python3 plugins/java-usages/tests/read-write.py /path/to/jdtls /path/to/lombok.jar > /tmp/read-write-indexed.json
```

The harnesses select the JDT LS configuration for the current platform. The first
verifies category coverage, standard-reference inclusion, boolean/fluent/prefix/chain
naming, overloads, inheritance and includeAccessors=false. The second checks
structural read/write cases, interface and inherited calls, nested same-line calls,
method references, receiver/array reads and a real cancellation response (`-32800`).

Use the actual desktop app to check read/write toggles, mutual toggle behavior,
Find transfer, persistence and unfiltered non-Java counts with the same fixture.

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
