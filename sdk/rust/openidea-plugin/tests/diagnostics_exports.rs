//! Inspect real components, including the two full export-order fixture features.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use wit_parser::WorldItem;

#[test]
fn diagnostics_registration_keeps_the_requested_interfaces() {
    let path = std::env::var_os("OPENIDEA_DIAGNOSTICS_COMPONENT").map(PathBuf::from).unwrap_or_else(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../crates/ide-plugin/tests/fixtures/diagnostics/dist/plugin.wasm")
    });
    let wit_parser::decoding::DecodedWasm::Component(resolve, world) =
        wit_parser::decoding::decode(&std::fs::read(&path).unwrap()).unwrap()
    else {
        panic!("expected a component")
    };
    let actual: BTreeSet<_> = resolve.worlds[world]
        .exports
        .values()
        .filter_map(|item| {
            let WorldItem::Interface { id, .. } = item else { return None };
            let interface = &resolve.interfaces[*id];
            let package = &resolve.packages[interface.package?];
            (package.name.namespace == "openidea").then_some(interface.name.as_deref()).flatten()
        })
        .collect();
    let mut expected = BTreeSet::from(["lifecycle", "commands", "event-handler", "diagnostics-provider"]);
    if std::env::var_os("OPENIDEA_DIAGNOSTICS_COMBINED").is_some() {
        expected.extend([
            "endpoints-provider",
            "view-provider",
            "document-indexer",
            "syntax-provider",
            "semantic-tokens-provider",
            "hover-provider",
            "providers",
            "inlay-hints-provider",
            "detail-provider",
            "commit-checker",
            "file-actions",
        ]);
    }
    println!("{} exports {actual:?}", path.display());
    assert_eq!(actual, expected);
}
