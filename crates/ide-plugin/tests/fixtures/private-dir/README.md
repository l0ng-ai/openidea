A real SDK component exercising `fs.plugin-dir` during activation and commands
without filesystem/project grants. It only writes fake text; `open` opens it in
the editor and `process` passes its path to an explicitly approved `cat`.

Rebuild with `plugins/build.sh crates/ide-plugin/tests/fixtures/private-dir`.
