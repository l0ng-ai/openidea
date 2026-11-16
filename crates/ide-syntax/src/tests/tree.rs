use super::*;

fn find_kind<'t>(node: tree_sitter::Node<'t>, kind: &str) -> Option<tree_sitter::Node<'t>> {
    if node.kind() == kind {
        return Some(node);
    }
    let mut cursor = node.walk();
    node.children(&mut cursor).find_map(|child| find_kind(child, kind))
}

#[test]
fn with_tree_reports_utf16_ranges() {
    let text = "class A { String s = \"é😀\"; int x = s.length(); }";
    let (range, byte, back) = service()
        .with_tree(&Snapshot::text(&lang("java"), text), &none(), |t| {
            let call = find_kind(t.tree.root_node(), "method_invocation").unwrap();
            (t.range(&call), t.byte(Pos::new(0, 36)), t.pos(39))
        })
        .unwrap();
    assert_eq!(range, Range::new(Pos::new(0, 36), Pos::new(0, 46)));
    assert_eq!(byte, 39);
    assert_eq!(back, Pos::new(0, 36));
}

#[test]
fn with_tree_needs_a_grammar() {
    let plaintext = lang("plaintext");
    let snap = Snapshot::text(&plaintext, "x");
    assert_eq!(service().with_tree(&snap, &none(), |_| ()).unwrap_err(), StructureError::Unsupported);
}

#[test]
fn with_tree_honours_cancellation() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let java = lang("java");
    let snap = Snapshot::text(&java, "class A {}");
    assert_eq!(service().with_tree(&snap, &cancel, |_| ()).unwrap_err(), StructureError::Cancelled);
}
