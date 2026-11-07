# Commit test fixture

`Describe Changes` (in the `commit.message` toolbar) reads the commit being
prepared and writes a message listing its files; the `markers` before-commit
check reports a message without a `type: ` prefix and every `DO NOT COMMIT`
added by the commit.

Used by `cargo test -p ide-host --test plugin_commit` to exercise the `commit`
interface and the optional `commit-checker` export. It is not a marketplace plugin.
