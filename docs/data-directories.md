# Data directories

OpenIDEA keeps its rebuildable data, such as downloaded tools, language servers,
JDKs and index caches, in the operating system's local data directory:

- **Windows:** `%LOCALAPPDATA%\ai.l0ng.openidea`
- **macOS:** `~/Library/Application Support/ai.l0ng.openidea`
- **Linux:** `~/.local/share/ai.l0ng.openidea`

To keep this data elsewhere, for example on another drive, set
`OPENIDEA_LOCAL_DATA_DIR` to an absolute path before starting OpenIDEA. The IDE
then uses `<OPENIDEA_LOCAL_DATA_DIR>/ai.l0ng.openidea` and creates it when
missing. If the path is relative or cannot be written, OpenIDEA shows an error
and exits instead of falling back to the default location.

```bat
setx OPENIDEA_LOCAL_DATA_DIR "E:\OpenIDEA"
```

Settings, plugins, scratches and other user data stay in the operating system's
data and configuration directories. Logs stay in their usual location, so they
are still written when the variable is wrong. Existing data is not moved: quit
OpenIDEA and move the old directory's contents to the new location, or let the
IDE download tools and rebuild indexes again.
