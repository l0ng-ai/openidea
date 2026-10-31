# Reproduce Java usage access filtering

## Small fixture

Use [ReadWrite.java](ReadWrite.java), a 24-line Java/Lombok fixture. It contains
ordinary `@Data`, explicit fluent `@Accessors`, direct field reads/writes,
compound updates, nested calls, inherited/interface calls and method references.
Its line positions are assertions in `read-write.py`; keep them stable.

For manual testing, create a Java project with Lombok 1.18.48 on its classpath
and copy this file into its source directory as `Bean.java`. For Maven, use JDK
21 or later and this minimal `pom.xml`:

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>example</groupId><artifactId>usage-access</artifactId><version>1.0</version>
  <dependencies>
    <dependency>
      <groupId>org.projectlombok</groupId><artifactId>lombok</artifactId>
      <version>1.18.48</version><scope>provided</scope>
    </dependency>
  </dependencies>
  <build><plugins><plugin>
    <groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId>
    <version>3.14.1</version>
    <configuration><release>21</release><annotationProcessorPaths><path>
      <groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><version>1.18.48</version>
    </path></annotationProcessorPaths></configuration>
  </plugin></plugins></build>
</project>
```

Open the project in OpenIDEA, allow JDT LS import/indexing to finish and verify
there are no Java error diagnostics. Leave `java.references.includeAccessors`
enabled. Invoke Show Usages on the **declaration** of `Bean.count` (Cmd-click on
macOS, or the corresponding navigation action). Use the declaration to avoid
navigating from a reference to its definition instead.

## Before and after

On unmodified main, the references appear together and cannot be filtered by
read/write access. Standard LSP references provide locations without this metadata.
With this change, both toolbar buttons are initially selected:

| Expression                               | Access     | Read only | Write only |
| ---------------------------------------- | ---------- | --------- | ---------- |
| `b.count` in an initializer              | Read       | Visible   | Hidden     |
| `b.count = 1`                            | Write      | Hidden    | Visible    |
| `b.count += 2`, `b.count++`, `--b.count` | Read/write | Visible   | Visible    |
| `b.getCount()`                           | Read       | Visible   | Hidden     |
| `b.setCount(...)`                        | Write      | Hidden    | Visible    |
| `b::getCount`, `b::setCount`             | Unknown    | Visible   | Visible    |

The two references in `b.setCount(b.getCount())` remain distinct even on one
line. Inherited and interface calls are included. Selecting `Fluent.score`
also includes `score()` and `score(int)` by method identity. `b.items[0] = 1`
reads `items`; it writes an element, not the field holding the array.

Turn off Show write accesses to inspect reads. Turn it back on and turn off Show
read accesses to inspect writes. Turning off the last enabled switch enables the
other. Move the results to Find: filters and original location metadata remain
available. Reopen the popup to check persistence. Unknown results must stay
visible in either mode. English tooltips are "Show read accesses" and "Show write
accesses"; the icons are vendored JetBrains resources, not a claim of complete UI
parity.

## Automated server evidence and Browser preview

The harness creates an Eclipse project with the same fixture, loads the actual
Lombok agent and extension, imports it in JDT LS, asserts semantic results and
checks cancellation. No Maven download is needed for this harness.

```sh
export PATH=/path/to/jdk25/bin:$PATH
python3 plugins/java-usages/tests/read-write.py /path/to/jdtls /path/to/lombok.jar > /tmp/read-write.json
pnpm exec vite --port 1451 --strictPort
# In another terminal, from this checkout:
OPENIDEA_TEST_URL=http://localhost:1451 node plugins/java-usages/tests/browser.mjs /tmp/read-write.json /tmp
```

The browser script uses `/usr/bin/chromium`; adjust its executable path for your
machine. Screenshots are **Browser preview: real frontend, replayed actual JDT LS
response**. They do not exercise the native Tauri bridge or macOS WebKit. Native
macOS acceptance remains pending; do not present these images as desktop captures.
For a desktop before/after demonstration use separate builds of the base and PR
with this same fixture, settings and import completion state.

## Scope and performance interpretation

This does not classify constructor initialization. Method references stay unknown,
and `lombok.config`-only naming or unusual signatures may remain unmapped.
See the parent README for internal API compatibility and conservative fallback.

A true no-feature timing baseline must omit this bundle entirely while retaining
the same Lombok agent, then call `textDocument/references` directly. Compare the
same query position, settings, server/compiler, fixture and import state. Measure
cold first queries separately from warmed samples. RPC timings exclude UI and
Rust orchestration. Fluent/prefixed fields may return fewer locations natively;
those timings are not equal-workload comparisons and cannot establish a semantic
speedup. Counter-instrumented runs must be separate from timing runs.
