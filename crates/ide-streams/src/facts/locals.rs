use ide_syntax::SyntaxTree;
use tree_sitter::Node;

/// A local variable or parameter declaration.
#[derive(Clone, Copy)]
pub(super) struct Local<'t> {
    pub(super) name: Node<'t>,
    /// `None` for an untyped lambda parameter or an `int a[]`-style declarator.
    pub(super) ty: Option<Node<'t>>,
    pub(super) value: Option<Node<'t>>,
}

/// The local or parameter named `name` that `from` sees, looking no further
/// out than `member`: declarations before `from` in each enclosing block,
/// then loop, catch, resource and lambda / method parameters.
pub(super) fn visible_local<'t>(t: &SyntaxTree<'t>, from: Node<'t>, member: Node<'t>, name: &str) -> Option<Local<'t>> {
    let named = |n: Node| t.text[n.byte_range()] == *name;
    let mut child = from;
    while let Some(p) = child.parent() {
        let mut cursor = p.walk();
        let found = match p.kind() {
            "block" | "switch_block_statement_group" | "resource_specification" => p
                .named_children(&mut cursor)
                .take_while(|c| c.end_byte() <= child.start_byte())
                .filter_map(|c| declarator(c, named).or_else(|| resource_of(c, named)))
                .last(),
            "for_statement" => p.child_by_field_name("init").and_then(|init| declarator(init, named)),
            "enhanced_for_statement" if p.child_by_field_name("body") == Some(child) => p
                .child_by_field_name("name")
                .filter(|n| named(*n))
                .map(|name| Local { name, ty: p.child_by_field_name("type"), value: None }),
            "try_with_resources_statement" if p.child_by_field_name("body") == Some(child) => {
                p.child_by_field_name("resources").and_then(|r| resource(r, named))
            }
            "catch_clause" => {
                p.named_children(&mut cursor).find(|c| c.kind() == "catch_formal_parameter").and_then(|c| {
                    c.child_by_field_name("name").filter(|n| named(*n)).map(|name| Local {
                        name,
                        ty: None,
                        value: None,
                    })
                })
            }
            "method_declaration" | "constructor_declaration" | "lambda_expression" => parameter(p, named),
            _ => None,
        };
        if found.is_some() || p == member {
            return found;
        }
        child = p;
    }
    None
}

fn resource<'t>(resources: Node<'t>, named: impl Fn(Node) -> bool + Copy) -> Option<Local<'t>> {
    let mut cursor = resources.walk();
    resources.named_children(&mut cursor).find_map(|r| resource_of(r, named))
}

fn resource_of<'t>(r: Node<'t>, named: impl Fn(Node) -> bool) -> Option<Local<'t>> {
    if r.kind() != "resource" {
        return None;
    }
    let name = r.child_by_field_name("name").filter(|n| named(*n))?;
    Some(Local { name, ty: r.child_by_field_name("type"), value: r.child_by_field_name("value") })
}

fn declarator<'t>(decl: Node<'t>, named: impl Fn(Node) -> bool) -> Option<Local<'t>> {
    if decl.kind() != "local_variable_declaration" {
        return None;
    }
    let mut cursor = decl.walk();
    decl.children_by_field_name("declarator", &mut cursor).find_map(|d| {
        let name = d.child_by_field_name("name").filter(|n| named(*n))?;
        let ty = decl.child_by_field_name("type").filter(|_| d.child_by_field_name("dimensions").is_none());
        Some(Local { name, ty, value: d.child_by_field_name("value") })
    })
}

fn parameter<'t>(decl: Node<'t>, named: impl Fn(Node) -> bool) -> Option<Local<'t>> {
    let params = decl.child_by_field_name("parameters")?;
    if params.kind() == "identifier" {
        return named(params).then_some(Local { name: params, ty: None, value: None });
    }
    let mut cursor = params.walk();
    params.named_children(&mut cursor).find_map(|p| match p.kind() {
        "identifier" => named(p).then_some(Local { name: p, ty: None, value: None }),
        "formal_parameter" => {
            let name = p.child_by_field_name("name").filter(|n| named(*n))?;
            let ty = p.child_by_field_name("type").filter(|_| p.child_by_field_name("dimensions").is_none());
            Some(Local { name, ty, value: None })
        }
        _ => None,
    })
}
