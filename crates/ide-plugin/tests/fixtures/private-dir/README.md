A real SDK component exercising `fs.plugin-dir` during activation and commands
without filesystem/project grants. `large-cache` writes an 80 MiB cache as ten
8 MiB files, beyond the storage quota while respecting each filesystem write limit. It only writes fake text; `open` opens it in
the editor and `process` passes its path to an explicitly approved `cat`.

Rebuild with `plugins/build.sh crates/ide-plugin/tests/fixtures/private-dir`.
