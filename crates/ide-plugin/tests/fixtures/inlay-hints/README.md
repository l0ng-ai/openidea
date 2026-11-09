# Inlay hints test fixture

After every `->name()` call in a PHP document that declares
`function name(): Type`, shows `: Type` as a type hint.

Used by `cargo test -p ide-host --test plugin_inlay_hints` to exercise the
optional `inlay-hints-provider` export. It is not a marketplace plugin.
