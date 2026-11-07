use super::Adjustment;
use super::locals::visible_local;
use super::rules::{Collector, is_variable_use};
use tree_sitter::Node;

/// Operations whose output elements have the input's type.
const KEEPS_ELEMENT_TYPE: &[&str] =
    &["filter", "sorted", "distinct", "peek", "limit", "skip", "takeWhile", "dropWhile"];

/// Which parameters of a lambda passed to `op` are stream elements.
enum ElementParams {
    First,
    All,
    None,
}

fn element_params(op: &str, args: usize) -> ElementParams {
    match op {
        "sorted" | "max" | "min" => ElementParams::All,
        "reduce" if args <= 2 => ElementParams::All,
        // Container, identity and array-size parameters.
        "reduce" | "collect" | "toArray" => ElementParams::None,
        _ => ElementParams::First,
    }
}

impl<'t> Collector<'_, 't> {
    /// Rule 8 for generic frames: each use of a lambda parameter whose type is
    /// a type variable `T extends B` is cast to `B`'s erasure. The element type
    /// is known only for a `List<T>` / `Collection<T>` / `Set<T>` / `T[]`
    /// source seen through type-preserving operations.
    pub(super) fn cast_generic_elements(&mut self, root: Node<'t>) {
        let Some(bound) = self.element_bound(root) else { return };
        let Some(bound) = self.dotted_type(&bound) else { return };
        let mut call = root;
        while call != self.chain {
            let Some(next) = call.parent().filter(|p| p.child_by_field_name("object") == Some(call)) else { return };
            call = next;
            let op = call.child_by_field_name("name").map_or("", |n| self.text(n));
            self.cast_lambda_params(call, op, &bound);
            if !KEEPS_ELEMENT_TYPE.contains(&op) {
                return;
            }
        }
    }

    /// The first bound's erasure of the source's element type variable.
    fn element_bound(&self, root: Node<'t>) -> Option<String> {
        let object = root.child_by_field_name("object")?;
        let args = root.child_by_field_name("arguments")?;
        let name = self.text(root.child_by_field_name("name")?);
        let (source, array) = match (name, object.kind(), args.named_child_count()) {
            ("stream", "identifier", 0) => (object, false),
            ("stream", "identifier", 1) if self.text(object) == "Arrays" => (args.named_child(0)?, true),
            _ => return None,
        };
        let source = source.kind().eq("identifier").then_some(source)?;
        let ty = visible_local(self.t, source, self.member, self.text(source))?.ty?;
        let var = match (ty.kind(), array) {
            ("generic_type", false) => {
                let collection =
                    ty.named_child(0).filter(|c| matches!(self.text(*c), "List" | "Collection" | "Set"))?;
                let args = collection.next_named_sibling().filter(|a| a.named_child_count() == 1)?;
                args.named_child(0)?
            }
            ("array_type", true) if ty.child_by_field_name("dimensions").is_some_and(|d| self.text(d) == "[]") => {
                ty.child_by_field_name("element")?
            }
            _ => return None,
        };
        let var = var.kind().eq("type_identifier").then(|| self.text(var))?;
        self.frame.type_params.iter().find(|(name, _)| name == var)?.1.clone()
    }

    fn cast_lambda_params(&mut self, call: Node<'t>, op: &str, bound: &str) {
        let Some(args) = call.child_by_field_name("arguments") else { return };
        let mut cursor = args.walk();
        let lambdas: Vec<_> = args.named_children(&mut cursor).filter(|a| a.kind() == "lambda_expression").collect();
        for lambda in lambdas {
            let (Some(params), Some(body)) =
                (lambda.child_by_field_name("parameters"), lambda.child_by_field_name("body"))
            else {
                continue;
            };
            let mut names = lambda_params(params);
            match element_params(op, args.named_child_count()) {
                ElementParams::First => names.truncate(1),
                ElementParams::All => {}
                ElementParams::None => names.clear(),
            }
            for name in names {
                let name = self.text(name);
                let mut uses = Vec::new();
                self.uses_in(body, name, &mut uses);
                for u in uses {
                    let adjustment = Adjustment::GenericCast { name: name.into(), to: bound.into() };
                    self.replace(u, format!("(({bound}) {name})"), adjustment);
                }
            }
        }
    }

    fn uses_in(&self, n: Node<'t>, name: &str, out: &mut Vec<Node<'t>>) {
        if n.kind() == "identifier" && self.text(n) == name && is_variable_use(n) {
            out.push(n);
        }
        let mut cursor = n.walk();
        // A nested class body may declare the name again.
        for child in n.children(&mut cursor).filter(|c| c.kind() != "class_body") {
            self.uses_in(child, name, out);
        }
    }
}

fn lambda_params(params: Node) -> Vec<Node> {
    if params.kind() == "identifier" {
        return vec![params];
    }
    let mut cursor = params.walk();
    params
        .named_children(&mut cursor)
        .filter_map(|p| match p.kind() {
            "identifier" => Some(p),
            "formal_parameter" => p.child_by_field_name("name"),
            _ => None,
        })
        .collect()
}
