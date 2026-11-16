use ide_syntax::SyntaxTree;
use tree_sitter::Node;

/// Whether `name`, used at `from`, is a local variable or parameter, looking no
/// further out than `member`: declarations before `from` in each enclosing
/// block, then loop, catch, resource and lambda / method parameters.
pub(crate) fn is_visible_local<'t>(t: &SyntaxTree<'t>, from: Node<'t>, member: Node<'t>, name: &str) -> bool {
    let named = |n: Node| t.text[n.byte_range()] == *name;
    let mut child = from;
    while let Some(p) = child.parent() {
        let mut cursor = p.walk();
        let found = match p.kind() {
            "block" | "switch_block_statement_group" | "resource_specification" => p
                .named_children(&mut cursor)
                .take_while(|c| c.end_byte() <= child.start_byte())
                .any(|c| declares(c, named) || is_resource(c, named)),
            "for_statement" => p.child_by_field_name("init").is_some_and(|init| declares(init, named)),
            "enhanced_for_statement" if p.child_by_field_name("body") == Some(child) => {
                p.child_by_field_name("name").is_some_and(named)
            }
            "try_with_resources_statement" if p.child_by_field_name("body") == Some(child) => {
                p.child_by_field_name("resources").is_some_and(|resources| {
                    let mut cursor = resources.walk();
                    resources.named_children(&mut cursor).any(|r| is_resource(r, named))
                })
            }
            "catch_clause" => p
                .named_children(&mut cursor)
                .find(|c| c.kind() == "catch_formal_parameter")
                .and_then(|c| c.child_by_field_name("name"))
                .is_some_and(named),
            "method_declaration" | "constructor_declaration" | "lambda_expression" => has_parameter(p, named),
            _ => false,
        };
        if found || p == member {
            return found;
        }
        child = p;
    }
    false
}

fn is_resource(r: Node, named: impl Fn(Node) -> bool) -> bool {
    r.kind() == "resource" && r.child_by_field_name("name").is_some_and(named)
}

fn declares(decl: Node, named: impl Fn(Node) -> bool) -> bool {
    if decl.kind() != "local_variable_declaration" {
        return false;
    }
    let mut cursor = decl.walk();
    decl.children_by_field_name("declarator", &mut cursor).any(|d| d.child_by_field_name("name").is_some_and(&named))
}

fn has_parameter(decl: Node, named: impl Fn(Node) -> bool) -> bool {
    let Some(params) = decl.child_by_field_name("parameters") else { return false };
    if params.kind() == "identifier" {
        return named(params);
    }
    let mut cursor = params.walk();
    params.named_children(&mut cursor).any(|p| match p.kind() {
        "identifier" => named(p),
        "formal_parameter" => p.child_by_field_name("name").is_some_and(&named),
        _ => false,
    })
}
