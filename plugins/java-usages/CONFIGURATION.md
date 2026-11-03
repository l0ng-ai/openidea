# Spring configuration navigation

`openidea.java.configuration` bridges YAML / properties to the existing JDT LS
Java model. It is bundled with the Java usages extension; it does not install a
second language server, run a build, change the application's dependencies, or
connect to external configuration services.

## Editor behavior

- **Go to Definition** on a YAML / properties key opens binding members and
  literal consumers in Java. Multiple matches use the existing location chooser.
- **Go to Definition** inside a Java `@Value` placeholder or a constant
  `Environment.getProperty` / `getRequiredProperty` argument opens matching
  configuration keys. Ordinary Java definition navigation remains native.
- **Find Usages** joins configuration declarations, property consumers, and Java
  references to associated binding members. Java's existing reference results and
  read/write classifications are retained.
- Open editor contents take precedence over disk. All matching profiles/documents
  are shown; navigation does not claim to know the runtime effective value.
- Missing or older extension bundles preserve native language-server behavior.
  YAML aliases still use the YAML server's anchor navigation.

## Association sources

The Java command resolves annotation and method identities with JDT bindings:

- `@ConfigurationProperties` on classes and factory methods, including inherited
  members, nested objects, records, constructor-only parameters / `@Name`, arrays,
  collections and maps. Binder keys use relaxed spelling while retaining path
  boundaries. Indexed collection positions and arbitrary map keys use wildcards.
- `@Value("${key:default}")`, including constant annotation values and nested
  default placeholders.
- Literal or compile-time constant keys passed to Spring's `PropertyResolver`
  methods, including through `Environment`. Unrelated methods with the same name
  and non-Spring annotations are excluded.
- Dependency JAR `META-INF/spring-configuration-metadata.json` and
  `additional-spring-configuration-metadata.json`. The closest group, source
  type, and source method locate a member or its owning class. Source attachments
  and JDT class-file/decompiler navigation use the existing virtual-document path.
- The same metadata files in source roots and `src/main/resources`.

YAML key ranges come from the bundled tree-sitter grammar, including nested/flow
mappings, sequences, quoted keys and multiple documents. Properties support
escaped keys, Unicode escapes and logical-line continuations. Ranges crossing
IPC are UTF-16. No new IPC type or frontend provider is required.

## Scope and costs

The command uses the selected JDT project's resolved package roots, including
source dependencies and its dependency JARs. Configuration search includes those
modules, skips nested independent modules and build output, and honors ignore
files for disk discovery. It does not guess a global association from matching
text in unrelated projects.

Indexing is lazy. The first explicit navigation/search builds a compact snapshot;
ordinary typing, code-lens probes, bulk scoped reference analysis, and Java Go to Definition / Ctrl+hover outside a `@Value` or property-lookup argument (checked with the bundled tree-sitter grammar) do not start indexing. At most eight project snapshots are
retained, with a shared 100,000-association retention cap. Records contain property names, element handles and source locations;
ASTs and bindings are discarded after indexing. A lexical prefilter avoids AST
construction for ordinary Java units, but every accepted association is resolved
semantically. Warm requests reuse the snapshot. Java model changes (sources on
disk, classpath, archives) invalidate it conservatively, including dependent-type
changes; a fingerprint of working copies with unsaved changes covers edits before
they are saved. Opening or closing an editor, reconciling, building, and non-Java
resource changes (configuration files are parsed by the client; metadata files are
checked by timestamp) keep it. This is **snapshot invalidation**, not a fully
incremental Java semantic index.

Metadata/JAR timestamps are checked before reuse. The client caches parsed disk
configuration files by modification time and size (at most 100,000 cached keys), overlays open buffers, and
performs bounded discovery/parsing on a blocking worker. It does not continuously
watch or parse an additional copy of the entire workspace.

Bounds: 20,000 Java units, 100,000 associations per snapshot, 2 MiB per candidate
metadata/configuration file (Java source: 2M UTF-16 units), 1,024-character property names, 2,000 configuration files/results, 50,000 filesystem
entries per root, and depth limits on recursive bindings/YAML. Java requests and
references are cancellable. File/association scan limits and unreadable files carry the
existing incomplete-result indicator; unsupported syntax keys are omitted. First navigation can take seconds on a
cold project; classpath import and source download remain owned by JDT LS.

## Deliberate limits

This is Java/Spring property navigation, not full IntelliJ Spring support. It
cannot infer dynamically constructed names, custom configuration APIs/annotations,
remote-only configuration, arbitrary SpEL evaluation, YAML merge/alias expansion,
or custom Spring converters that change the binding shape. Kotlin is not indexed
by this Java bundle. YAML-only quoted-string escape forms that cannot be decoded
safely are skipped. Properties surrogate-pair escapes are not decoded as keys.
A missing source attachment may navigate to the decompiled owning class when JDT
cannot provide an exact member range. Binding members are navigation candidates;
the feature does not validate whether Spring will successfully bind a bean at
runtime or resolve profile/precedence rules.

## Verification

Use the JDT LS distribution / Java version documented in [README](README.md).

```sh
python3 plugins/java-usages/build.py /path/to/jdtls
python3 plugins/java-usages/tests/configuration.py /path/to/jdtls
OPENIDEA_CONFIGURATION_STRESS=1 python3 plugins/java-usages/tests/configuration.py /path/to/jdtls
OPENIDEA_SPRING_BOOT_JAR=/path/to/spring-boot-autoconfigure.jar python3 plugins/java-usages/tests/configuration.py /path/to/jdtls
cargo test -p ide-language -p ide-lsp
```

The isolated real-server harness covers custom bindings, inheritance, nesting,
collections/maps, records, constructor aliases, factory methods, consumers,
constant keys, negative identity matches, dependency metadata/source locations,
reverse queries, and unsaved-change/close invalidation. Optional stress fixtures
add 3,000 ordinary units and 100 binding classes; output includes cold/warm/edit
latencies for the JDT command only, excluding server import, UI and configuration-file discovery. The optional actual Spring Boot JAR checks `server.port`,
`spring.datasource.url` and `spring.jackson.date-format` through dependency
metadata. No user's project is compiled or modified by the harness.

Rust tests cover configuration syntax/ranges and the actual manager bridge:
YAML navigation without YAML definition capabilities, Java native fallback,
reference merging, profiles, open-buffer overlays and sibling-module exclusion.
Existing Java usages / read-write integration harnesses remain regression checks.
