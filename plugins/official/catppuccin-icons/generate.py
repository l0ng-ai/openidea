#!/usr/bin/env python3
"""Generates icons/<flavor>/ and the four theme.json files of the Catppuccin Icons plugin.

The icons and the file/folder associations come from catppuccin/vscode-icons
(MIT), the same source the JetBrains plugin catppuccin/jetbrains-icons is built
from. Clone it, then:

    python3 generate.py /path/to/vscode-icons
    openidea-plugin check .

The associations are read from src/defaults/{fileIcons,folderIcons}.ts as text;
nothing from the checkout is executed. Not part of the package (plugin.toml does
not reference it), so it is not installed.
"""

from __future__ import annotations

import json
import pathlib
import re
import shutil
import sys

HERE = pathlib.Path(__file__).resolve().parent
FLAVORS = ["latte", "frappe", "macchiato", "mocha"]
ENTRY = re.compile(r"^  '?([\w.-]+)'?: \{$")
FIELD = re.compile(r"^    (languageIds|fileExtensions|fileNames|folderNames): \[(.*)$")
STRING = re.compile(r"""'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)\"""")


def parse_table(path: pathlib.Path, var: str) -> dict[str, dict[str, list[str]]]:
    """{icon: {field: [names]}} of the `const <var> = { … }` literal, in file order."""
    lines = path.read_text(encoding="utf-8").splitlines()
    start = next(i for i, l in enumerate(lines) if re.match(rf"const {var}\b.*= \{{$", l)) + 1
    table: dict[str, dict[str, list[str]]] = {}
    icon = field = None
    for line in lines[start:]:
        if line == "}":
            break
        if field:
            body += line
        elif m := ENTRY.match(line):
            icon, table[icon] = m.group(1), {}
            continue
        elif m := FIELD.match(line):
            field, body = m.group(1), m.group(2)
        else:
            continue
        if "]" in body:
            names = [a or b for a, b in STRING.findall(body.split("]")[0])]
            table[icon].setdefault(field, []).extend(names)
            field = None
    return table


def icon_id(stem: str) -> str:
    """`_folder_open` -> `folder-open`, `folder_src` -> `folder-src`."""
    return stem.lstrip("_").replace("_", "-")


def build(src: pathlib.Path, flavor: str, files: dict, folders: dict) -> dict:
    icons = src / "icons" / flavor
    out = HERE / "icons" / flavor
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    stems = sorted(p.stem for p in icons.glob("*.svg"))
    ids = {}
    for stem in stems:
        i = icon_id(stem)
        assert i not in ids, f"{stem} and {ids[i]} share the id {i}"
        ids[i] = stem
        shutil.copyfile(icons / f"{stem}.svg", out / f"{i}.svg")
    have = set(ids)

    def known(stem: str) -> str | None:
        return icon_id(stem) if icon_id(stem) in have else None

    theme: dict = {
        "iconDefinitions": {i: f"icons/{flavor}/{i}.svg" for i in sorted(have)},
        "file": "file",
        "folder": "folder",
        "folderExpanded": "folder-open",
        "folderOpen": "folder-open",
    }

    # A later icon claims a name an earlier one listed, as in the VS Code theme.
    patterns = []
    for key in ("fileExtensions", "fileNames"):
        mapping = {}
        for icon, fields in files.items():
            if (i := known(icon)) is None:
                continue
            for name in fields.get(key, []):
                # `workflows/yml` (GitHub Actions) names a folder and an extension: keys can't hold a
                # slash, so it becomes a path pattern.
                if "/" in name:
                    folder, ext = name.lower().rsplit("/", 1)
                    patterns.append(
                        {"pattern": f"/{re.escape(folder)}/[^/]+\\.{re.escape(ext)}$", "icon": i, "path": True, "ignoreCase": True}
                    )
                else:
                    mapping[name.lower()] = i
        theme[key] = dict(sorted(mapping.items()))

    names = {}
    for icon, fields in folders.items():
        closed, opened = known(f"folder_{icon}"), known(f"folder_{icon}_open")
        if closed is None:
            continue
        for name in fields.get("folderNames", []):
            names[name.lower()] = (closed, opened)
    theme["folderNames"] = {n: c for n, (c, _) in sorted(names.items())}
    # Hollow folders swap a folder holding the open file for its open icon, which
    # only patterns can name.
    for name, (closed, opened) in sorted(names.items()):
        if opened:
            patterns.append(
                {"pattern": f"^{re.escape(name)}$", "icon": closed, "openIcon": opened, "target": "folder", "ignoreCase": True}
            )
    theme["patterns"] = patterns

    (out / "theme.json").write_text(json.dumps(theme, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"icons": len(have), "extensions": len(theme["fileExtensions"]), "names": len(theme["fileNames"]), "folders": len(names)}


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = pathlib.Path(sys.argv[1]).resolve()
    files = parse_table(src / "src/defaults/fileIcons.ts", "fileIcons")
    folders = parse_table(src / "src/defaults/folderIcons.ts", "folderIcons")
    for flavor in FLAVORS:
        print(flavor, build(src, flavor, files, folders))


if __name__ == "__main__":
    main()
