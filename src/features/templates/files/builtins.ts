/** Built-in file templates for the "New ▸" menu, with the includes and code templates they `#parse`. */
import type { FileTemplate, TemplateFragment } from "./model";

/** Includes tab: fragments file templates pull in with `#parse("…")`. */
export const BUILTIN_INCLUDES: readonly TemplateFragment[] = [{ name: "File Header", body: "" }];

/** Code tab: the members the built-in test templates generate. */
export const BUILTIN_CODE_TEMPLATES: readonly TemplateFragment[] = [
  {
    name: "JUnit5 Test Method",
    description: "Java Class › JUnit 5 Test",
    body: "@Test\nvoid test() {\n    $END$\n}\n",
  },
  {
    name: "Kotlin JUnit5 Test Method",
    description: "Kotlin Class/File › JUnit 5 Test",
    body: "@Test\nfun test() {\n    $END$\n}\n",
  },
  {
    name: "Go Test Function",
    description: "Go File › Test file",
    body: "func Test$NAME$(t *testing.T) {\n\t$END$\n}\n",
  },
  {
    name: "Rust Test Function",
    description: "Rust File › Test module",
    body: "#[test]\nfn it_works() {\n    $END$\n}\n",
  },
  {
    name: "Vitest Test",
    description: "TypeScript File › Test",
    body: 'it("works", () => {\n  $END$\n});\n',
  },
  {
    name: "pytest Test Function",
    description: "Python File › Test (pytest)",
    body: "def test_$NAME$():\n    $END$\n",
  },
];

export const BUILTIN_FILE_TEMPLATES: readonly FileTemplate[] = [
  {
    id: "file",
    name: "File",
    icon: "file",
    extension: "",
    nameStyle: "asis",
    kinds: [{ id: "file", label: "File", body: "$END$" }],
  },
  {
    id: "rust",
    name: "Rust File",
    icon: "file-rust",
    extension: "rs",
    nameStyle: "snake",
    kinds: [
      { id: "module", label: "Module", body: "$END$\n" },
      { id: "struct", label: "Struct", body: "pub struct $NAME$ {\n    $END$\n}\n" },
      {
        id: "test",
        label: "Test module",
        body: '#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #parse("Rust Test Function")\n}\n',
      },
    ],
  },
  {
    id: "typescript",
    name: "TypeScript File",
    icon: "file-ts",
    extension: "ts",
    nameStyle: "asis",
    kinds: [
      { id: "file", label: "File", body: "$END$\n" },
      { id: "class", label: "Class", body: "export class $NAME$ {\n  $END$\n}\n" },
      {
        id: "test",
        label: "Test",
        body: 'import { describe, expect, it } from "vitest";\n\ndescribe("$NAME$", () => {\n  #parse("Vitest Test")\n});\n',
      },
    ],
  },
  {
    id: "tsx",
    name: "React Component",
    icon: "file-tsx",
    extension: "tsx",
    nameStyle: "pascal",
    kinds: [
      {
        id: "component",
        label: "Function component",
        body: "export interface $NAME$Props {}\n\nexport function $NAME$(props: $NAME$Props) {\n  return <div>$END$</div>;\n}\n",
      },
      {
        id: "styled",
        label: "Component with CSS module",
        body: 'import styles from "./$NAME$.module.css";\n\nexport function $NAME$() {\n  return <div className={styles.root}>$END$</div>;\n}\n',
      },
    ],
  },
  {
    id: "javascript",
    name: "JavaScript File",
    icon: "file-js",
    extension: "js",
    nameStyle: "asis",
    kinds: [{ id: "file", label: "File", body: "$END$\n" }],
  },
  {
    id: "python",
    name: "Python File",
    icon: "file-python",
    extension: "py",
    nameStyle: "snake",
    kinds: [
      { id: "module", label: "Module", body: '"""$NAME$ module."""\n\n$END$\n' },
      {
        id: "class",
        label: "Class",
        body: "class $NAME$:\n    def __init__(self):\n        $END$\n",
      },
      { id: "test", label: "Test (pytest)", body: '#parse("pytest Test Function")\n' },
      { id: "script", label: "Script", body: 'def main():\n    $END$\n\n\nif __name__ == "__main__":\n    main()\n' },
    ],
  },
  {
    id: "go",
    name: "Go File",
    icon: "file-go",
    extension: "go",
    nameStyle: "snake",
    packageStyle: "go",
    kinds: [
      { id: "file", label: "Empty file", body: "package $PACKAGE$\n\n$END$\n" },
      {
        id: "test",
        label: "Test file",
        body: 'package $PACKAGE$\n\nimport "testing"\n\n#parse("Go Test Function")\n',
      },
      { id: "main", label: "Main", body: "package main\n\nfunc main() {\n\t$END$\n}\n" },
    ],
  },
  {
    id: "java",
    name: "Java Class",
    icon: "class",
    extension: "java",
    nameStyle: "pascal",
    packageStyle: "jvm",
    dottedPackages: true,
    kinds: [
      {
        id: "class",
        label: "Class",
        body: 'package $PACKAGE$;\n\n#parse("File Header")\npublic class $NAME$ {\n    $END$\n}\n',
      },
      {
        id: "interface",
        label: "Interface",
        body: 'package $PACKAGE$;\n\n#parse("File Header")\npublic interface $NAME$ {\n    $END$\n}\n',
      },
      {
        id: "enum",
        label: "Enum",
        body: 'package $PACKAGE$;\n\n#parse("File Header")\npublic enum $NAME$ {\n    $END$\n}\n',
      },
      {
        id: "record",
        label: "Record",
        body: 'package $PACKAGE$;\n\n#parse("File Header")\npublic record $NAME$($END$) {\n}\n',
      },
      {
        id: "annotation",
        label: "Annotation",
        body: 'package $PACKAGE$;\n\n#parse("File Header")\npublic @interface $NAME$ {\n    $END$\n}\n',
      },
      {
        id: "test",
        label: "JUnit 5 Test",
        body: 'package $PACKAGE$;\n\nimport org.junit.jupiter.api.Test;\n\nimport static org.junit.jupiter.api.Assertions.*;\n\n#parse("File Header")\nclass $NAME$ {\n\n    #parse("JUnit5 Test Method")\n}\n',
      },
    ],
  },
  {
    id: "kotlin",
    name: "Kotlin Class/File",
    icon: "class",
    extension: "kt",
    nameStyle: "pascal",
    packageStyle: "jvm",
    dottedPackages: true,
    kinds: [
      {
        id: "class",
        label: "Class",
        body: 'package $PACKAGE$\n\n#parse("File Header")\nclass $NAME$ {\n    $END$\n}\n',
      },
      { id: "file", label: "File", body: "package $PACKAGE$\n\n$END$\n" },
      {
        id: "interface",
        label: "Interface",
        body: 'package $PACKAGE$\n\n#parse("File Header")\ninterface $NAME$ {\n    $END$\n}\n',
      },
      {
        id: "data",
        label: "Data class",
        body: 'package $PACKAGE$\n\n#parse("File Header")\ndata class $NAME$($END$)\n',
      },
      {
        id: "enum",
        label: "Enum class",
        body: 'package $PACKAGE$\n\n#parse("File Header")\nenum class $NAME$ {\n    $END$\n}\n',
      },
      {
        id: "object",
        label: "Object",
        body: 'package $PACKAGE$\n\n#parse("File Header")\nobject $NAME$ {\n    $END$\n}\n',
      },
      {
        id: "test",
        label: "JUnit 5 Test",
        body: 'package $PACKAGE$\n\nimport org.junit.jupiter.api.Test\nimport org.junit.jupiter.api.Assertions.*\n\n#parse("File Header")\nclass $NAME$ {\n\n    #parse("Kotlin JUnit5 Test Method")\n}\n',
      },
    ],
  },
  {
    id: "html",
    name: "HTML File",
    icon: "file-html",
    extension: "html",
    nameStyle: "asis",
    kinds: [
      {
        id: "html5",
        label: "HTML 5 file",
        body: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>$NAME$</title>\n</head>\n<body>\n$END$\n</body>\n</html>\n',
      },
      { id: "fragment", label: "Fragment", body: "$END$\n" },
    ],
  },
  {
    id: "markdown",
    name: "Markdown File",
    icon: "file-md",
    extension: "md",
    nameStyle: "asis",
    kinds: [{ id: "md", label: "Markdown file", body: "# $NAME$\n\n$END$\n" }],
  },
  {
    id: "excalidraw",
    name: "Excalidraw Diagram",
    icon: "file-excalidraw",
    extension: "excalidraw",
    nameStyle: "asis",
    kinds: [
      {
        id: "excalidraw",
        label: "Excalidraw diagram",
        body: '{\n  "type": "excalidraw",\n  "version": 2,\n  "source": "https://excalidraw.com",\n  "elements": [\n    $END$\n  ],\n  "appState": {\n    "gridSize": null,\n    "viewBackgroundColor": "#ffffff"\n  },\n  "files": {}\n}\n',
      },
    ],
  },
  {
    // IDEA's "Stylesheet": one dialog, the kind picks the language.
    id: "stylesheet",
    name: "Stylesheet",
    icon: "file-css",
    extension: "css",
    nameStyle: "asis",
    kinds: [
      { id: "css", label: "CSS File", body: "$END$\n" },
      { id: "scss", label: "SCSS File", body: "$END$\n", extension: "scss" },
      { id: "sass", label: "Sass File", body: "$END$\n", extension: "sass" },
      { id: "less", label: "Less File", body: "$END$\n", extension: "less" },
    ],
  },
  {
    id: "json",
    name: "JSON File",
    icon: "file-json",
    extension: "json",
    nameStyle: "asis",
    kinds: [{ id: "json", label: "JSON file", body: "{\n  $END$\n}\n" }],
  },
  {
    id: "yaml",
    name: "YAML File",
    icon: "file-yaml",
    extension: "yaml",
    nameStyle: "asis",
    kinds: [{ id: "yaml", label: "YAML file", body: "$END$\n" }],
  },
  {
    id: "toml",
    name: "TOML File",
    icon: "file-toml",
    extension: "toml",
    nameStyle: "asis",
    kinds: [{ id: "toml", label: "TOML file", body: "$END$\n" }],
  },
  {
    id: "shell",
    name: "Shell Script",
    icon: "file-shell",
    extension: "sh",
    nameStyle: "asis",
    kinds: [
      { id: "bash", label: "Bash script", body: "#!/usr/bin/env bash\nset -euo pipefail\n\n$END$\n" },
      { id: "sh", label: "POSIX sh script", body: "#!/bin/sh\n\n$END$\n" },
      { id: "zsh", label: "Zsh script", body: "#!/usr/bin/env zsh\n\n$END$\n", extension: "zsh" },
    ],
  },
  {
    id: "dockerfile",
    name: "Dockerfile",
    icon: "file-docker",
    extension: "",
    nameStyle: "asis",
    defaultName: "Dockerfile",
    kinds: [{ id: "dockerfile", label: "Dockerfile", body: "FROM $END$\n" }],
  },
  {
    id: "editorconfig",
    name: "EditorConfig File",
    icon: "file-config",
    extension: "",
    nameStyle: "asis",
    defaultName: ".editorconfig",
    kinds: [
      {
        id: "default",
        label: "Default properties",
        body: "root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\nindent_style = space\nindent_size = 4\ninsert_final_newline = true\ntrim_trailing_whitespace = true\n$END$",
      },
      { id: "root", label: "Root only", body: "root = true\n\n[*]\n$END$\n" },
    ],
  },
  {
    id: "gitignore",
    name: ".gitignore File",
    icon: "file-git",
    extension: "",
    nameStyle: "asis",
    defaultName: ".gitignore",
    kinds: [{ id: "gitignore", label: ".gitignore file", body: "$END$\n" }],
  },
];
