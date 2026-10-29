# Third-party licenses

## JetBrains IntelliJ Platform icons

`src/ui/expui/**` contains SVG icons from the IntelliJ Platform "new UI" (expui)
icon set, copied unmodified (some renamed) from JetBrains' open-source repositories:

- [intellij-community](https://github.com/JetBrains/intellij-community) (Apache-2.0):
  `platform/icons/src/expui/**` (incl. `fileTypes/` c, cpp, h, Csharp, typeScript,
  sql, graphql, docker, gitignore, gradle, groovy, jenkins, jupyter, rst, swiftLang,
  terraform, vue, bazel); `python/python-parser` (`fileTypes/python`);
  `python/python-requirements` (`fileTypes/requirements`); `python/pipenv`
  (`fileTypes/pipenv`); `python/python-pyproject` (`expui/toml.svg` →
  `fileTypes/pyprojectToml`); `plugins/kotlin/base` (`fileTypes/kotlin`,
  `kotlinScript`, `kotlinGradleScript`); `java/openapi` (`fileTypes/maven`);
  `plugins/markdown` (`fileTypes/markdown`); `plugins/toml` (`fileTypes/toml`);
  `plugins/terminal` (`toolwindows/terminal`); `plugins/maven`
  (`images/expui/toolwindow/maven` → `toolwindows/maven`, `images/expui/build/maven*`
  → `maven/`); `plugins/gradle` (`icons/expui/gradle` → `toolwindows/gradle`,
  `icons/expui/gradleLoadChanges` → `build/gradleLoadChanges`);
  `platform/external-system-impl` (`icons/newui/task` → `externalSystem/task`).
  Copyright 2000-2026 JetBrains s.r.o. and contributors. Apache License 2.0 (below).
- [intellij-plugins](https://github.com/JetBrains/intellij-plugins) (each plugin
  carries its own licence): `protobuf/protoeditor-core` (`newui/protoFile` →
  `fileTypes/protoFile`, Apache-2.0); `terraform` (`newui/hashiCorp` →
  `fileTypes/hashiCorp`, Apache-2.0); `makefile` (`expui/makefile` →
  `fileTypes/makefile`, MIT, Copyright (c) 2016 Victor Kropp — full text below).

At render time `src/ui/icons.tsx` may recolour monochrome icons to `currentColor`.

## JetBrains IntelliJ Platform diff algorithm

`src/features/vcs/comparison/**` is a TypeScript port of the text comparison of
[intellij-community](https://github.com/JetBrains/intellij-community) (Apache-2.0):
`platform/util/diff` (`com.intellij.util.diff`: Diff, Reindexer, MyersLCS,
PatienceIntLCS, UniqueLCS; `com.intellij.diff.comparison`: ByLineRt, ByWordRt,
ByCharRt, ChunkOptimizer, ChangeCorrector, LineFragmentSplitter, TrimUtil,
ComparisonUtil, iterables) and `platform/diff-impl` (ComparisonManagerImpl's
`compareLinesInner` and `processBlocks`). `__tests__/ideaCases.json` is converted
from its tests (`LineComparisonUtilTest`, `WordComparisonUtilTest`,
`SplitComparisonUtilTest`). Modified from the originals. Copyright 2000-2026
JetBrains s.r.o. and contributors. Apache License 2.0 (below).

`src/ui/openidea/**` holds OpenIDEA's own file-type icons drawn in the expui style for
languages whose JetBrains icons are not open source (Go, Rust, Ruby, Dart, Lua, Zig,
Svelte, …). Those using the page-with-corner-badge layout (`goMod`, `goWork`,
`dotenv`, `readme`, `lock`, `license`) reuse the page outline of the Apache-2.0
expui `fileTypes/h.svg`; that outline is modified from the original by JetBrains.
`src/ui/openidea/runConfigurations/springBoot*.svg` (the Spring Boot run configuration
leaf) is OpenIDEA's own drawing.

The lettering in `src-tauri/icons/source/openidea-wordmark*.svg` is outlined from
Inter Tight (Copyright 2022 The Inter Project Authors, SIL Open Font License 1.1,
https://github.com/rsms/inter-tight).

### MIT License (makefile icon)

Copyright (c) 2016 Victor Kropp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Tools downloaded on request (not bundled)

The tool installer (`crates/ide-tools`, Settings › Languages & Frameworks ›
Language Servers) downloads third-party language servers and debuggers into the
user's app-data directory only when the user asks; none of them ships with OpenIDEA.

- **Microsoft java-debug** (Java debugger, loaded into jdtls as a bundle):
  `com.microsoft.java.debug.plugin-*.jar` from <https://github.com/microsoft/java-debug>,
  Copyright (c) Microsoft Corporation, licensed under the
  [Eclipse Public License 1.0](https://github.com/microsoft/java-debug/blob/main/LICENSE.txt)
  (EPL-1.0; it embeds `commons-io` and `rxjava`/`reactive-streams`, Apache-2.0). OpenIDEA
  takes the jar from the `vscjava.vscode-java-debug` extension package on Open VSX
  (<https://open-vsx.org/extension/vscjava/vscode-java-debug>, the extension itself is
  MIT-licensed), verifies its published SHA-256 and extracts only the jar; it is used
  unmodified, and its source is available from the repository above.
- **Eclipse JDT Language Server** (jdtls): EPL-2.0, from download.eclipse.org.

## en_US / en_GB Hunspell dictionaries

`crates/ide-spell/src/dict/en_US.{aff,dic}` (the spell checker's bundled dictionary) is the
SCOWL-derived en_US Hunspell dictionary (version 2020.12.07, from the `dictionary-en` npm
package 4.0.0), copied unmodified. Copyright Kevin Atkinson and the SCOWL / Hunspell
dictionary contributors; MIT- and BSD-style licences, full text in
`crates/ide-spell/src/dict/LICENSE-en_US`. `crates/ide-spell/src/dict/en_GB-extra.dic` holds the
entries of the matching en_GB dictionary (`dictionary-en-gb` npm package 3.0.0, same SCOWL
version, licence and affix file) that en_US lacks. They are checked with the
[spellbook](https://github.com/helix-editor/spellbook) crate (MPL-2.0).

## cspell-dicts word lists

`crates/ide-spell/src/dict/cspell-terms.txt` (programming terms the spell checker accepts)
is derived from the software-terms, typescript, node, rust, fullstack, golang, java, cpp,
shell and css dictionaries of [cspell-dicts](https://github.com/streetsidesoftware/cspell-dicts)
(October 2026): lowercased, filtered and merged by OpenIDEA. Copyright Street Side Software;
MIT licence, full text in `crates/ide-spell/src/dict/LICENSE-cspell-dicts`.

## CodeMirror Angular template language

`src/editor/core/cm/angular/` (`angular.grammar`, `tokens.ts`, `index.ts` and the
`parser.ts` generated from them) is derived from
[@codemirror/lang-angular](https://github.com/codemirror/lang-angular) 0.1.4
(commit `ecc5038f`). Copyright (C) 2018-2021 by Marijn Haverbeke and others; MIT
licence, full text in `src/editor/core/cm/angular/LICENSE`. Modifications by
OpenIDEA: control-flow blocks (`@if`, `@for`, `@switch`, `@defer`, ...) and `@let`
declarations, key and animation binding names (`(keydown.enter)`, `[@fade]`,
`(@fade.done)`), runs of text that entities split (`a && b`) parsed as one, and one
token for `{` and `}`.

## nvim-treesitter queries

`crates/ide-syntax/queries/<grammar>/locals.scm` are derived from the `locals.scm`
queries of [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter)
(`runtime/queries/`, commit `29212d82`, October 2026), Apache License 2.0 (the
same text as the Apache-2.0 licence below). Copyright the nvim-treesitter
contributors. Modifications by OpenIDEA: `inherits:` chains flattened (ecma,
c → cpp, php_only), node names adapted to the bundled grammar versions
(Kotlin for tree-sitter-kotlin-ng, Dart, Swift, Haskell, C#, Bash), member
definitions re-kinded as `field` / `method`, and missing scopes, definitions and
references added; each file's header notes its changes.

---

Apache License

Version 2.0, January 2004

http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.

"Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work (an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or counterclaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:

You must give any other recipients of the Work or Derivative Works a copy of this License; and

You must cause any modified files to carry prominent notices stating that You changed the files; and

You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and

If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License. You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

## Solarized

The Solarized palettes in `src/styles/tokens.css` are adapted from
[Ethan Schoonover’s Solarized](https://github.com/altercation/solarized/tree/62f656a02f93c5190a8753159e34b385588d5ff3).
See [theme sources and mapping](docs/themes.md). MIT license:

```text
Copyright (c) 2011 Ethan Schoonover

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Atom One Light and One Dark

The One palettes and semantic syntax mapping in `src/styles/tokens.css` are
adapted from GitHub’s Atom One syntax and UI themes.
Source revisions are listed in [theme sources and mapping](docs/themes.md).
Both syntax themes use the following MIT notice:

```text
Copyright (c) 2016 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Both UI themes use the following MIT notice:

```text
Copyright (c) 2014 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Chinese UI terminology from Visual Studio Code

Some Simplified Chinese terms in `src/platform/locales/text/zh.json` follow the
wording of the Visual Studio Code Simplified Chinese language pack
([microsoft/vscode-loc](https://github.com/microsoft/vscode-loc), MIT), e.g.
"未跟踪" (untracked), "合并冲突" (merge conflicts), "当前" (current), "已修改"
(modified), "已过时" (outdated), "中止" (abort), "正在卸载" (uninstalling),
"深色" / "浅色" (dark / light) and "只读" (read-only). The remaining translations
are written for this project.

```
Visual Studio Code Localization Packs

Copyright (c) Microsoft Corporation

All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
```
