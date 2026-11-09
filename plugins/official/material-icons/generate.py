#!/usr/bin/env python3
"""Generates icons/*.svg and icons/theme.json of the Material Icons plugin.

Flat, original icons on the Material colour palette: language files are
coloured badges with a short label, well-known files get glyphs, folders are
tinted by role. Edit the tables below and run `python3 generate.py`, then
`openidea-plugin check .`. Not part of the package (plugin.toml does not
reference it), so it is not installed.
"""

import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "icons"
FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"


def svg(body: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">{body}</svg>\n'


def badge(color: str, label: str, fg: str = "#fff") -> str:
    size = {1: 9.5, 2: 7.4, 3: 5.6}[len(label)]
    y = 8 + size * 0.36
    label = label.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return svg(
        f'<rect x="1" y="1" width="14" height="14" rx="3" fill="{color}"/>'
        f'<text x="8" y="{y:.2f}" fill="{fg}" font-family="{FONT}" font-size="{size}" '
        f'font-weight="700" text-anchor="middle" letter-spacing="-0.2">{label}</text>'
    )


def doc(color: str, inner: str = "") -> str:
    return svg(
        f'<path fill="{color}" d="M4 1h5.6L13 4.4V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/>'
        f'<path fill="#fff" fill-opacity=".45" d="M9.6 1v3.4H13z"/>{inner}'
    )


def folder(color: str, open_: bool = False) -> str:
    if open_:
        return svg(
            f'<path fill="{color}" d="M1.5 2.5h4.6L7.6 4h6.4a1 1 0 0 1 1 1v1.5H4.2L2 13.5H1.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/>'
            f'<path fill="{color}" fill-opacity=".75" d="M4.2 7h11.3l-2.2 6.5H2z"/>'
        )
    return svg(
        f'<path fill="{color}" d="M1.5 2.5h4.6L7.6 4h6.9a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/>'
    )


def stroke(d: str, color: str = "#fff", width: float = 1.4) -> str:
    return (
        f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
    )


def gear(color: str) -> str:
    teeth = "".join(
        f'<rect x="6.9" y="0.8" width="2.2" height="3.2" rx=".5" transform="rotate({a} 8 8)"/>'
        for a in range(0, 360, 45)
    )
    return svg(f'<g fill="{color}">{teeth}</g><circle cx="8" cy="8" r="3.6" fill="none" stroke="{color}" stroke-width="2.8"/>')


def atom(color: str) -> str:
    rings = "".join(
        f'<ellipse cx="8" cy="8" rx="6.6" ry="2.5" transform="rotate({a} 8 8)"/>' for a in (0, 60, 120)
    )
    return svg(f'<g fill="none" stroke="{color}" stroke-width="1.1">{rings}</g><circle cx="8" cy="8" r="1.4" fill="{color}"/>')


def package(color: str) -> str:
    return svg(
        f'<path fill="{color}" d="M8 1l6.5 3.2v7.6L8 15l-6.5-3.2V4.2z"/>'
        '<path fill="#000" fill-opacity=".22" d="M8 7.4V15l6.5-3.2V4.2z"/>'
        '<path fill="#fff" fill-opacity=".35" d="M1.5 4.2L8 7.4l6.5-3.2L8 1z"/>'
    )


GLYPHS = {
    "file": doc("#90a4ae"),
    "text": doc("#90a4ae", stroke("M5 7.5h6M5 10h6M5 12.5h4", width=1.1)),
    "markdown": svg(
        '<rect x="0.5" y="3" width="15" height="10" rx="1.6" fill="#42a5f5"/>'
        + stroke("M3 10.5v-5l2 2.5 2-2.5v5", width=1.3)
        + stroke("M11 5.5v5M9.2 8.8l1.8 1.8 1.8-1.8", width=1.3)
    ),
    "image": svg(
        '<rect x="1" y="2.5" width="14" height="11" rx="1.5" fill="#26a69a"/>'
        '<circle cx="5" cy="6" r="1.5" fill="#fff"/>'
        '<path fill="#fff" d="M2.5 12l3.5-4 2.5 2.6L11 7.4l3 4.6z"/>'
    ),
    "archive": svg(
        '<rect x="2" y="1" width="12" height="14" rx="1.5" fill="#af8e5b"/>'
        '<path fill="#fff" d="M7 1h2v1.6H7zm0 3.2h2v1.6H7zM6.4 7.6h3.2v4.4H6.4z"/>'
        '<rect x="7.2" y="9.8" width="1.6" height="1.2" fill="#af8e5b"/>'
    ),
    "lock": svg(
        '<rect x="3" y="7" width="10" height="8" rx="1.5" fill="#90a4ae"/>'
        + stroke("M5.5 7V5a2.5 2.5 0 0 1 5 0v2", "#90a4ae", 1.8)
        + '<circle cx="8" cy="11" r="1.2" fill="#fff"/>'
    ),
    "git": svg(
        '<path fill="#f4511e" d="M8 .6l7.4 7.4L8 15.4.6 8z"/>'
        + stroke("M6.3 5v6M6.3 6.4c0 1.8 3.7.4 3.7 2.1", width=1.1)
        + '<g fill="#fff"><circle cx="6.3" cy="5" r="1.1"/><circle cx="6.3" cy="11" r="1.1"/><circle cx="10" cy="8.6" r="1.1"/></g>'
    ),
    "settings": gear("#78909c"),
    "env": gear("#fbc02d"),
    "readme": svg(
        '<circle cx="8" cy="8" r="7" fill="#42a5f5"/>'
        '<rect x="7.1" y="6.8" width="1.8" height="5.2" rx=".6" fill="#fff"/><circle cx="8" cy="4.6" r="1.1" fill="#fff"/>'
    ),
    "license": svg(
        '<rect x="1.5" y="2" width="13" height="9.5" rx="1" fill="#ffca28"/>'
        + stroke("M3.6 4.6h6.4M3.6 6.8h4", "#fff", 1.1)
        + '<path fill="#ef6c00" d="M9.6 11.4l-.7 3.4 2.1-1.1 2.1 1.1-.7-3.4z"/><circle cx="11" cy="10" r="2.3" fill="#ef6c00"/>'
    ),
    "shell": svg(
        '<rect x="1" y="2" width="14" height="12" rx="2" fill="#4caf50"/>'
        + stroke("M4 5.5l2.5 2.5L4 10.5", width=1.5)
        + stroke("M8 10.8h4", width=1.5)
    ),
    "database": svg(
        '<path fill="#ffca28" d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9z"/>'
        '<ellipse cx="8" cy="3.5" rx="5.5" ry="2" fill="#ffe082"/>'
        + stroke("M2.5 7.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2", "#ffe082", 0.9)
    ),
    "html": svg('<rect x="1" y="1" width="14" height="14" rx="3" fill="#e44d26"/>' + stroke("M6 5L3.5 8 6 11M10 5l2.5 3L10 11")),
    "xml": svg('<rect x="1" y="1" width="14" height="14" rx="3" fill="#ff9800"/>' + stroke("M5.5 5L3 8l2.5 3M10.5 5L13 8l-2.5 3M9 4.5l-2 7", width=1.2)),
    "json": badge("#fbc02d", "{}", "#5d4037"),
    "react": atom("#00bcd4"),
    "react-ts": atom("#0288d1"),
    "docker": svg(
        '<rect x="1" y="1" width="14" height="14" rx="3" fill="#0288d1"/>'
        '<g fill="#fff"><rect x="3" y="7" width="2.2" height="2"/><rect x="5.6" y="7" width="2.2" height="2"/>'
        '<rect x="8.2" y="7" width="2.2" height="2"/><rect x="5.6" y="4.6" width="2.2" height="2"/>'
        '<rect x="8.2" y="4.6" width="2.2" height="2"/></g>'
        '<path fill="#fff" d="M2.6 9.6h10.6c.4-.8 1-1.2 1.6-1.2-.3 3-2.6 4.6-6.4 4.6-3.2 0-5.2-1.2-5.8-3.4z"/>'
    ),
    "npm": package("#cb3837"),
    "cargo": package("#ff7043"),
    "gomod": package("#00acc1"),
    "pnpm": package("#f9ad00"),
    "test": svg(
        '<rect x="1" y="1" width="14" height="14" rx="3" fill="#8bc34a"/>' + stroke("M4.2 8.2l2.4 2.4 5.2-5.2", width=1.7)
    ),
    "vite": badge("#9575cd", "V"),
    "tsconfig": badge("#0288d1", "TS", "#bbdefb"),
    "makefile": badge("#ef5350", "M"),
    "editorconfig": gear("#90a4ae"),
    "font": badge("#ef5350", "Aa"),
    "pdf": badge("#e53935", "PDF"),
    "svg": badge("#ffb300", "SVG", "#4e342e"),
    "audio": svg('<rect x="1" y="1" width="14" height="14" rx="3" fill="#ec407a"/><path fill="#fff" d="M6 4.5l6-1.5v7.3a1.8 1.8 0 1 1-1.2-1.7V5.4L7.2 6.3v5.4a1.8 1.8 0 1 1-1.2-1.7z"/>'),
    "video": svg('<rect x="1" y="2.5" width="14" height="11" rx="2" fill="#ff7043"/><path fill="#fff" d="M6.4 5.5v5l4-2.5z"/>'),
}

# extension → (icon id, colour, label[, label colour])
LANGUAGES = {
    "rust": ("#ff7043", "RS", ["rs"]),
    "typescript": ("#0288d1", "TS", ["ts", "mts", "cts"]),
    "typescript-def": ("#0277bd", "D", ["d.ts", "d.mts", "d.cts"]),
    "javascript": ("#fbc02d", "JS", ["js", "mjs", "cjs"], "#3e2723"),
    "python": ("#3572a5", "PY", ["py", "pyi", "pyw"], "#ffd54f"),
    "go": ("#00acc1", "GO", ["go"]),
    "java": ("#e53935", "J", ["java"]),
    "class": ("#8d6e63", "CL", ["class", "jar"]),
    "kotlin": ("#7e57c2", "KT", ["kt", "kts"]),
    "groovy": ("#4db6ac", "GR", ["groovy", "gradle"]),
    "scala": ("#d32f2f", "SC", ["scala", "sc", "sbt"]),
    "c": ("#5c6bc0", "C", ["c"]),
    "cpp": ("#1e88e5", "C++", ["cpp", "cc", "cxx", "c++"]),
    "header": ("#9575cd", "H", ["h", "hpp", "hh", "hxx", "inl"]),
    "csharp": ("#388e3c", "C#", ["cs", "csx"]),
    "fsharp": ("#378bba", "F#", ["fs", "fsi", "fsx"]),
    "swift": ("#ff5722", "SW", ["swift"]),
    "objc": ("#607d8b", "OC", ["m", "mm"]),
    "ruby": ("#c62828", "RB", ["rb", "erb", "rake", "gemspec"]),
    "php": ("#7986cb", "PHP", ["php"]),
    "perl": ("#5c6bc0", "PL", ["pl", "pm"]),
    "lua": ("#3949ab", "LUA", ["lua"]),
    "r": ("#1976d2", "R", ["r", "rmd"]),
    "julia": ("#9558b2", "JL", ["jl"]),
    "dart": ("#40c4ff", "D", ["dart"], "#01579b"),
    "elixir": ("#7e57c2", "EX", ["ex", "exs", "heex"]),
    "erlang": ("#c2185b", "ER", ["erl", "hrl"]),
    "haskell": ("#7e57c2", "HS", ["hs", "lhs"]),
    "ocaml": ("#ef6c00", "ML", ["ml", "mli"]),
    "clojure": ("#64dd17", "CLJ", ["clj", "cljs", "cljc", "edn"], "#1b5e20"),
    "zig": ("#f9a825", "Z", ["zig", "zon"], "#3e2723"),
    "nim": ("#ffc107", "NIM", ["nim"], "#3e2723"),
    "solidity": ("#546e7a", "SOL", ["sol"]),
    "vue": ("#41b883", "V", ["vue"]),
    "svelte": ("#ff3e00", "S", ["svelte"]),
    "astro": ("#ff5d01", "A", ["astro"]),
    "css": ("#42a5f5", "#", ["css"]),
    "sass": ("#ec407a", "#", ["scss", "sass"]),
    "less": ("#1565c0", "LS", ["less"]),
    "yaml": ("#e53935", "YML", ["yaml", "yml"]),
    "toml": ("#8d6e63", "TML", ["toml"]),
    "ini": ("#78909c", "INI", ["ini", "cfg", "conf", "properties"]),
    "csv": ("#43a047", "CSV", ["csv", "tsv"]),
    "graphql": ("#e535ab", "GQ", ["graphql", "gql"]),
    "proto": ("#26a69a", "PB", ["proto"]),
    "wasm": ("#654ff0", "WA", ["wasm", "wat"]),
    "nix": ("#5277c3", "NIX", ["nix"]),
    "terraform": ("#7b42bc", "TF", ["tf", "tfvars", "hcl"]),
    "powershell": ("#0277bd", "PS", ["ps1", "psm1", "psd1"]),
    "batch": ("#546e7a", "BAT", ["bat", "cmd"]),
    "tex": ("#008080", "TEX", ["tex", "sty", "bib"]),
    "vim": ("#43a047", "VI", ["vim"]),
    "diff": ("#66bb6a", "+-", ["diff", "patch"]),
    "log": ("#78909c", "LOG", ["log"]),
    "notebook": ("#f57c00", "NB", ["ipynb"]),
    "http": ("#3f51b5", "API", ["http", "rest"]),
}

GLYPH_EXTENSIONS = {
    "text": ["txt", "text"],
    "markdown": ["md", "markdown", "mdx"],
    "image": ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff", "icns"],
    "svg": ["svg"],
    "pdf": ["pdf"],
    "archive": ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"],
    "lock": ["lock"],
    "shell": ["sh", "bash", "zsh", "fish"],
    "database": ["sql", "sqlite", "db", "prisma"],
    "html": ["html", "htm", "xhtml"],
    "xml": ["xml", "xsd", "xsl", "plist", "iml"],
    "json": ["json", "jsonc", "json5"],
    "react": ["jsx"],
    "react-ts": ["tsx"],
    "test": [f"{kind}.{ext}" for kind in ("test", "spec") for ext in ("ts", "tsx", "js", "jsx", "mjs", "mts")]
    + ["test.rs", "test.py"],
    "font": ["ttf", "otf", "woff", "woff2"],
    "audio": ["mp3", "wav", "ogg", "flac", "m4a"],
    "video": ["mp4", "mov", "webm", "mkv", "avi"],
    "env": ["env"],
}

FILE_NAMES = {
    "readme": ["readme", "readme.md", "readme.txt", "readme.rst"],
    "license": ["license", "licence", "license.md", "licence.md", "license.txt", "copying", "notice"],
    "git": [".gitignore", ".gitattributes", ".gitmodules", ".gitkeep", ".mailmap"],
    "docker": ["dockerfile", "containerfile", ".dockerignore", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
    "npm": ["package.json", ".npmrc", ".npmignore"],
    "cargo": ["cargo.toml", "rust-toolchain", "rust-toolchain.toml"],
    "gomod": ["go.mod", "go.sum", "go.work"],
    "pnpm": ["pnpm-workspace.yaml"],
    "lock": ["cargo.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "poetry.lock", "uv.lock", "gemfile.lock", "composer.lock"],
    "env": [".env", ".env.local", ".env.development", ".env.production", ".env.example"],
    "tsconfig": ["tsconfig.json", "jsconfig.json", "tsconfig.base.json"],
    "vite": ["vite.config.ts", "vite.config.js", "vite.config.mts", "vitest.config.ts", "vitest.config.mts"],
    "makefile": ["makefile", "gnumakefile", "justfile", "cmakelists.txt"],
    "editorconfig": [".editorconfig", ".prettierrc", ".prettierignore", ".oxlintrc.json", ".eslintrc", ".eslintrc.json", "mise.toml"],
    "settings": [".clippy.toml", "clippy.toml", "rustfmt.toml", ".rustfmt.toml", "deny.toml"],
}

# folder name → (icon id, colour)
FOLDERS = {
    "folder-src": ("#4caf50", ["src", "source", "sources", "lib", "libs", "pkg", "internal", "crates", "packages"]),
    "folder-test": ("#8bc34a", ["test", "tests", "__tests__", "spec", "specs", "e2e", "fixtures", "testdata"]),
    "folder-docs": ("#42a5f5", ["doc", "docs", "documentation", "wiki"]),
    "folder-dist": ("#e57373", ["dist", "build", "out", "target", "bin", "obj", "release", "coverage"]),
    "folder-deps": ("#9ccc65", ["node_modules", "vendor", ".venv", "venv", "third_party", "deps"]),
    "folder-git": ("#ff7043", [".git", ".github", ".gitlab", ".husky"]),
    "folder-config": ("#78909c", ["config", "configs", ".config", ".vscode", ".idea", ".cargo", "settings", "etc"]),
    "folder-assets": ("#26a69a", ["assets", "static", "public", "images", "img", "icons", "fonts", "media", "resources", "res"]),
    "folder-scripts": ("#ffb74d", ["scripts", "script", "tools", "tasks", "ci"]),
    "folder-components": ("#ffca28", ["components", "ui", "widgets", "views", "pages", "features"]),
    "folder-styles": ("#ec407a", ["styles", "css", "scss", "theme", "themes"]),
    "folder-plugins": ("#ab47bc", ["plugins", "extensions", "addons", "sdk"]),
    "folder-i18n": ("#5c6bc0", ["i18n", "locales", "locale", "lang", "translations"]),
    "folder-api": ("#26c6da", ["api", "server", "routes", "handlers", "rpc"]),
    "folder-db": ("#ffa726", ["db", "database", "migrations", "sql", "schema"]),
}


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.svg"):
        old.unlink()
    icons: dict[str, str] = {}

    def add(name: str, content: str) -> None:
        assert name not in icons, f"duplicate icon {name}"
        icons[name] = content
        (OUT / f"{name}.svg").write_text(content)

    for name, content in GLYPHS.items():
        add(name, content)
    add("folder", folder("#90a4ae"))
    add("folder-open", folder("#90a4ae", open_=True))

    extensions: dict[str, str] = {}

    def map_ext(ext: str, icon: str) -> None:
        assert ext not in extensions, f"extension {ext} mapped twice"
        extensions[ext] = icon

    for name, (color, label, exts, *fg) in LANGUAGES.items():
        add(name, badge(color, label, *fg))
        for ext in exts:
            map_ext(ext, name)
    for icon, exts in GLYPH_EXTENSIONS.items():
        for ext in exts:
            map_ext(ext, icon)

    file_names = {n: icon for icon, names in FILE_NAMES.items() for n in names}
    folder_names: dict[str, str] = {}
    for icon, (color, names) in FOLDERS.items():
        add(icon, folder(color))
        for n in names:
            assert n not in folder_names, f"folder {n} mapped twice"
            folder_names[n] = icon

    for mapping in (extensions, file_names, folder_names):
        for key, icon in mapping.items():
            assert icon in icons, f"{key} → unknown icon {icon}"

    theme = {
        "iconDefinitions": {name: f"icons/{name}.svg" for name in sorted(icons)},
        "file": "file",
        "folder": "folder",
        "folderExpanded": "folder-open",
        "fileExtensions": dict(sorted(extensions.items())),
        "fileNames": dict(sorted(file_names.items())),
        "folderNames": dict(sorted(folder_names.items())),
    }
    (OUT / "theme.json").write_text(json.dumps(theme, indent=2) + "\n")
    print(f"{len(icons)} icons, {len(extensions)} extensions, {len(file_names)} file names, {len(folder_names)} folders")


if __name__ == "__main__":
    main()
