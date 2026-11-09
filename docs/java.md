# Java language servers

Settings › Languages & Frameworks › Language Servers lists Eclipse JDT Language
Server (`jdtls`) and [kmp-lsp](https://github.com/Hessesian/kmp-lsp). Select either
tool and use **Language server for Java** to choose one. The choice can be global
or limited to the current project. **Automatic** prefers jdtls and falls back to
kmp-lsp when jdtls is not installed; **None** disables both.

Install kmp-lsp from that page, or point its executable path at an existing
installation. The IDE downloads a platform distribution containing both kmp-lsp
and its native JAR indexer. Reinstall and uninstall manage both together.

kmp-lsp offers syntax-based Java code insight without running a JVM. It does not
provide JDT's compiler analysis, Lombok integration, or JDT-specific refactorings.
Java Application builds, classpath discovery and the Microsoft Java debugger still
require jdtls; use jdtls for those flows. Maven and Gradle build tasks can run
independently of the selected code-insight server.

This built-in choice applies to Java. Kotlin and Swift keep their existing server
choices. To use another server, add it with **New Language Server**, assign its
languages, and disable the servers it replaces.
