# Hover test fixture

Over a name the PHP document declares as `function <name>(`, shows
`**<name>** · declared on line <n>` for the name's range; nothing elsewhere.

Used by `cargo test -p ide-host --test plugin_hover` to exercise the optional
`hover-provider` export. It is not a marketplace plugin.
