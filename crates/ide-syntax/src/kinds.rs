//! Per-grammar node-kind tables that make the structure queries language-agnostic.
//!
//! Each grammar names its blocks, class bodies and expressions differently; the
//! tables below map them onto three roles:
//!  - *blocks*: containers whose direct named children are statements;
//!  - *members*: containers whose direct named children are member declarations;
//!  - *expressions*: from the grammar's supertypes (`expression`, `_expression`…)
//!    when it has them, the `expressions` lists, and naming conventions.
//!
//! The file root is always both a block and a member container. Grammars
//! without an entry get [`DEFAULT`] plus the naming heuristics.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tree_sitter::{Language, Node};

/// How a second declaration of a name in the same scope behaves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Redeclaration {
    /// A new variable visible after its declaration (Rust `let`, Lua `local`, Elixir rebinding).
    Shadow,
    /// The same variable (assignment declares: Python, Ruby, PHP, Bash).
    Merge,
    /// Not well defined (a compile error or JS `var`): resolved by position, reported uncertain.
    Conflict,
}

pub(crate) struct LangKinds {
    pub grammars: &'static [&'static str],
    pub blocks: &'static [&'static str],
    /// Branches of a `switch` / `when` (`case 1:` with its statements): moved as one statement,
    /// among their sibling branches only.
    pub clauses: &'static [&'static str],
    pub members: &'static [&'static str],
    /// A block whose parent has one of these kinds is a member container (Python class bodies).
    pub member_parents: &'static [&'static str],
    pub expressions: &'static [&'static str],
    pub not_expressions: &'static [&'static str],
    /// `(parent kind, field)` positions holding member / label names, not variables.
    /// An empty field matches every child of that parent kind.
    pub member_fields: &'static [(&'static str, &'static str)],
    /// `(parent kind, token)`: a name directly followed by the token is a label (`f(x = 1)`).
    pub labels: &'static [(&'static str, &'static str)],
    /// Lambda-like kinds beyond the generic ones (`lambda`, `closure`, `arrow_function`…).
    pub functions: &'static [&'static str],
    pub redeclaration: Redeclaration,
    /// Fields / methods are in scope as bare names inside the class (`x` means `this.x`),
    /// so a member declaration shadows outer locals. Otherwise members only exist
    /// in member position and their declarations are ignored for name resolution.
    pub implicit_members: bool,
    pub locals: Option<&'static str>,
}

macro_rules! locals {
    ($name:literal) => {
        Some(include_str!(concat!("../queries/", $name, "/locals.scm")))
    };
}

const NONE: &[&str] = &[];

pub(crate) const DEFAULT: LangKinds = LangKinds {
    grammars: NONE,
    blocks: &["block", "statement_block", "compound_statement", "statement_list", "statements"],
    clauses: NONE,
    members: &["class_body", "declaration_list", "field_declaration_list", "enum_body", "interface_body"],
    member_parents: NONE,
    expressions: NONE,
    not_expressions: NONE,
    member_fields: &[],
    labels: &[],
    functions: NONE,
    redeclaration: Redeclaration::Conflict,
    implicit_members: false,
    locals: None,
};

static TABLES: &[LangKinds] = &[
    LangKinds {
        grammars: &["rust"],
        blocks: &["block"],
        members: &["declaration_list", "field_declaration_list", "enum_variant_list"],
        expressions: &["self", "unit_expression"],
        not_expressions: &["let_condition", "match_arm", "match_block", "token_tree"],
        member_fields: &[("macro_invocation", "macro"), ("field_initializer", "field")],
        redeclaration: Redeclaration::Shadow,
        locals: locals!("rust"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["javascript", "typescript", "tsx"],
        blocks: &["statement_block", "switch_case", "switch_default", "class_static_block"],
        members: &["class_body", "interface_body", "object_type", "enum_body"],
        expressions: &["this", "super", "regex", "array", "object", "jsx_element", "jsx_self_closing_element"],
        not_expressions: &["statement_identifier", "sequence_expression"],
        member_fields: &[("labeled_statement", "label"), ("jsx_attribute", ""), ("jsx_opening_element", "name")],
        locals: None,
        ..DEFAULT
    },
    LangKinds {
        grammars: &["python"],
        blocks: &["block"],
        members: NONE,
        member_parents: &["class_definition"],
        expressions: &[
            "call",
            "attribute",
            "subscript",
            "list",
            "dictionary",
            "set",
            "tuple",
            "string",
            "concatenated_string",
            "integer",
            "float",
            "true",
            "false",
            "none",
            "lambda",
            "await",
            "binary_operator",
            "unary_operator",
            "comparison_operator",
            "boolean_operator",
            "not_operator",
            "list_comprehension",
            "dictionary_comprehension",
            "set_comprehension",
            "generator_expression",
        ],
        member_fields: &[("keyword_argument", "name")],
        redeclaration: Redeclaration::Merge,
        locals: locals!("python"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["java"],
        blocks: &["block", "constructor_body", "switch_block_statement_group"],
        members: &["class_body", "interface_body", "enum_body", "enum_body_declarations", "annotation_type_body"],
        expressions: &[
            "method_invocation",
            "field_access",
            "array_access",
            "object_creation_expression",
            "array_creation_expression",
            "method_reference",
            "string_literal",
            "this",
            "super",
            "true",
            "false",
            "null_literal",
            "class_literal",
        ],
        member_fields: &[("method_invocation", "name")],
        implicit_members: true,
        locals: locals!("java"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["kotlin"],
        blocks: &["block", "statements", "control_structure_body"],
        clauses: &["when_entry"],
        members: &["class_body", "enum_class_body"],
        expressions: &["this_expression", "super_expression", "string_literal", "lambda_literal", "object_literal"],
        labels: &[("value_argument", "=")],
        functions: &["lambda_literal", "anonymous_function"],
        implicit_members: true,
        locals: locals!("kotlin"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["go"],
        blocks: &["statement_list", "block", "expression_case", "default_case", "type_case", "communication_case"],
        clauses: &["expression_case", "default_case", "type_case", "communication_case"],
        members: &["field_declaration_list"],
        expressions: &["func_literal", "composite_literal", "true", "false", "nil", "iota"],
        not_expressions: &["expression_list", "literal_value", "keyed_element", "literal_element"],
        member_fields: &[("keyed_element", "key")],
        functions: &["func_literal"],
        locals: locals!("go"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["c"],
        blocks: &["compound_statement", "case_statement"],
        members: &["field_declaration_list", "enumerator_list"],
        expressions: &["true", "false", "null", "concatenated_string"],
        locals: locals!("c"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["cpp"],
        blocks: &["compound_statement", "case_statement"],
        members: &["field_declaration_list", "declaration_list", "enumerator_list"],
        expressions: &["this", "true", "false", "null", "nullptr", "concatenated_string", "lambda_expression"],
        implicit_members: true,
        locals: locals!("cpp"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["csharp"],
        blocks: &["block", "switch_section"],
        members: &["declaration_list", "enum_member_declaration_list"],
        expressions: &["this", "base", "boolean_literal", "null_literal"],
        member_fields: &[("argument", "name")],
        functions: &["anonymous_method_expression"],
        implicit_members: true,
        locals: locals!("csharp"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["ruby"],
        blocks: &["body_statement", "then", "else", "do", "block_body", "begin", "ensure", "rescue", "when"],
        members: NONE,
        member_parents: &["class", "module", "singleton_class"],
        expressions: &[
            "call",
            "binary",
            "unary",
            "array",
            "hash",
            "string",
            "integer",
            "float",
            "symbol",
            "simple_symbol",
            "true",
            "false",
            "nil",
            "self",
            "constant",
            "range",
            "lambda",
            "parenthesized_statements",
            "element_reference",
            "conditional",
        ],
        member_fields: &[("call", "method")],
        functions: &["block", "do_block", "lambda"],
        redeclaration: Redeclaration::Merge,
        locals: locals!("ruby"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["php"],
        blocks: &["compound_statement", "case_statement", "default_statement", "switch_block"],
        members: &["declaration_list", "enum_declaration_list"],
        expressions: &[
            "variable_name",
            "encapsed_string",
            "string",
            "integer",
            "float",
            "boolean",
            "null",
            "array_creation_expression",
        ],
        member_fields: &[
            ("member_access_expression", "name"),
            ("member_call_expression", "name"),
            ("nullsafe_member_access_expression", "name"),
            ("nullsafe_member_call_expression", "name"),
            ("scoped_call_expression", "name"),
            ("argument", "name"),
        ],
        redeclaration: Redeclaration::Merge,
        locals: locals!("php"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["swift"],
        blocks: &["statements"],
        members: &["class_body", "protocol_body", "enum_class_body"],
        expressions: &["simple_identifier", "self_expression", "super_expression", "boolean_literal", "lambda_literal"],
        member_fields: &[("value_argument_label", ""), ("navigation_suffix", "suffix")],
        functions: &["lambda_literal"],
        implicit_members: true,
        locals: locals!("swift"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["scala"],
        blocks: &["block", "indented_block", "case_block"],
        members: &["template_body"],
        expressions: &["string", "interpolated_string_expression", "boolean_literal", "unit"],
        implicit_members: true,
        locals: locals!("scala"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["lua"],
        blocks: &["block", "chunk"],
        members: NONE,
        expressions: &[
            "function_call",
            "string",
            "number",
            "true",
            "false",
            "nil",
            "table_constructor",
            "vararg_expression",
        ],
        member_fields: &[("method_index_expression", "method"), ("field", "name")],
        redeclaration: Redeclaration::Shadow,
        locals: locals!("lua"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["bash"],
        blocks: &["compound_statement", "do_group", "else_clause", "elif_clause", "case_item", "subshell"],
        members: NONE,
        expressions: &["simple_expansion", "expansion", "string", "raw_string", "number", "command_substitution"],
        redeclaration: Redeclaration::Merge,
        locals: locals!("bash"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["dart"],
        blocks: &["block", "switch_statement_case", "switch_statement_default"],
        members: &["class_body", "extension_body", "enum_body", "mixin_body"],
        expressions: &[
            "this",
            "super",
            "true",
            "false",
            "null_literal",
            "string_literal",
            "list_literal",
            "set_or_map_literal",
        ],
        member_fields: &[("label", ""), ("named_argument", "")],
        functions: &["function_expression"],
        implicit_members: true,
        locals: locals!("dart"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["elixir"],
        blocks: &["do_block", "stab_clause", "body", "else_block", "after_block", "rescue_block", "catch_block"],
        members: NONE,
        expressions: &[
            "call",
            "binary_operator",
            "unary_operator",
            "dot",
            "string",
            "integer",
            "float",
            "atom",
            "list",
            "map",
            "tuple",
            "boolean",
            "nil",
            "anonymous_function",
            "access_call",
            "sigil",
        ],
        not_expressions: &["stab_clause", "arguments", "keywords"],
        functions: &["anonymous_function"],
        redeclaration: Redeclaration::Shadow,
        locals: locals!("elixir"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["zig"],
        blocks: &["block", "block_expression"],
        members: &["container_declaration", "struct_declaration", "enum_declaration", "union_declaration"],
        expressions: &[
            "builtin_function",
            "call_expression",
            "field_expression",
            "string",
            "integer",
            "float",
            "boolean",
            "null",
        ],
        locals: locals!("zig"),
        ..DEFAULT
    },
    LangKinds {
        grammars: &["haskell"],
        blocks: &["local_binds", "exp_do", "do"],
        members: &["declarations", "class_declarations", "instance_declarations"],
        expressions: &[
            "variable",
            "constructor",
            "literal",
            "string",
            "integer",
            "float",
            "char",
            "apply",
            "infix",
            "lambda",
            "parens",
            "list",
            "tuple",
            "let_in",
            "conditional",
            "case",
        ],

        locals: locals!("haskell"),
        ..DEFAULT
    },
];

/// Grammars with a bundled `locals.scm` (TypeScript / TSX share one query).
pub(crate) fn locals_source(grammar: &str) -> Option<&'static str> {
    match grammar {
        "javascript" => locals!("javascript"),
        "typescript" | "tsx" => locals!("typescript"),
        _ => kinds_for(grammar).locals,
    }
}

fn kinds_for(grammar: &str) -> &'static LangKinds {
    TABLES.iter().find(|t| t.grammars.contains(&grammar)).unwrap_or(&DEFAULT)
}

/// Kind tables resolved against one grammar (kind ids from its supertypes).
pub(crate) struct Kinds {
    pub table: &'static LangKinds,
    expression_ids: HashSet<u16>,
}

/// Supertypes whose subtypes are expressions.
const EXPRESSION_SUPERTYPES: &[&str] = &[
    "expression",
    "_expression",
    "primary_expression",
    "non_lvalue_expression",
    "lvalue_expression",
    "_literal",
    "literal",
];

/// Leaf kinds that are always expressions.
const GENERIC_EXPRESSIONS: &[&str] = &[
    "identifier",
    "simple_identifier",
    "shorthand_property_identifier",
    "this",
    "self",
    "super",
    "true",
    "false",
    "null",
    "nil",
    "number",
    "integer",
    "float",
    "string",
    "template_string",
];

/// Fields whose node names something (a declaration, a type, a pattern) rather than computing a value.
const NON_EXPRESSION_FIELDS: &[&str] = &[
    "name",
    "type",
    "pattern",
    "label",
    "parameters",
    "parameter",
    "alias",
    "type_parameters",
    "type_arguments",
    "return_type",
    "result",
    "superclass",
    "interfaces",
    "declarator",
    "bound_identifier",
    "external_name",
    "returns",
];

impl Kinds {
    pub(crate) fn for_grammar(grammar: &'static str, language: &Language) -> &'static Kinds {
        static CACHE: OnceLock<Mutex<HashMap<&'static str, &'static Kinds>>> = OnceLock::new();
        let mut map = CACHE.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner());
        map.entry(grammar).or_insert_with(|| Box::leak(Box::new(Kinds::new(kinds_for(grammar), language))))
    }

    fn new(table: &'static LangKinds, language: &Language) -> Self {
        let mut expression_ids = HashSet::new();
        let mut stack: Vec<u16> = language
            .supertypes()
            .iter()
            .copied()
            .filter(|&s| language.node_kind_for_id(s).is_some_and(|k| EXPRESSION_SUPERTYPES.contains(&k)))
            .collect();
        let mut seen = HashSet::new();
        while let Some(s) = stack.pop() {
            if !seen.insert(s) {
                continue;
            }
            for &sub in language.subtypes_for_supertype(s) {
                if language.node_kind_is_supertype(sub) {
                    stack.push(sub);
                } else {
                    expression_ids.insert(sub);
                }
            }
        }
        Self { table, expression_ids }
    }

    pub(crate) fn redeclaration(&self) -> Redeclaration {
        self.table.redeclaration
    }

    pub(crate) fn is_clause(&self, node: &Node) -> bool {
        self.table.clauses.contains(&node.kind())
    }

    pub(crate) fn is_block(&self, node: &Node) -> bool {
        node.parent().is_none() || self.table.blocks.contains(&node.kind())
    }

    pub(crate) fn is_member_container(&self, node: &Node) -> bool {
        let kind = node.kind();
        node.parent().is_none()
            || self.table.members.contains(&kind)
            || (self.table.member_parents.iter().any(|p| node.parent().is_some_and(|n| n.kind() == *p))
                && (self.table.blocks.contains(&kind) || kind == "block"))
    }

    /// A scope whose definitions are members (class bodies, the class node itself, modules).
    pub(crate) fn is_member_scope(&self, node: &Node) -> bool {
        self.is_member_container(node) || is_type_like(node.kind())
    }

    /// Lambdas, closures and nested function literals.
    pub(crate) fn is_function_like(&self, node: &Node) -> bool {
        let kind = node.kind();
        self.table.functions.contains(&kind)
            || ["lambda", "closure", "arrow_function", "func_literal", "anonymous_function", "function_expression"]
                .iter()
                .any(|k| kind.contains(k))
            || (kind.contains("function") && (kind.contains("definition") || kind.contains("declaration")))
            || kind.contains("method_declaration")
            || kind == "method"
    }

    pub(crate) fn is_expression(&self, node: &Node) -> bool {
        if !node.is_named() || node.is_extra() || node.is_error() || node.is_missing() {
            return false;
        }
        let kind = node.kind();
        if self.table.not_expressions.contains(&kind) || kind.ends_with("statement") || kind.ends_with("_list") {
            return false;
        }
        let by_kind = self.expression_ids.contains(&node.kind_id())
            || self.table.expressions.contains(&kind)
            || GENERIC_EXPRESSIONS.contains(&kind)
            || kind.ends_with("_expression")
            || kind.ends_with("_literal")
            || kind == "expression";
        if !by_kind {
            return false;
        }
        let Some(parent) = node.parent() else { return false };
        if let Some(field) = field_name(node) {
            if NON_EXPRESSION_FIELDS.contains(&field) {
                // `name:` of a call-like parent is still a callee expression in some grammars.
                return false;
            }
            if field == "left"
                && ["assignment", "for", "declaration", "augmented"].iter().any(|k| parent.kind().contains(k))
            {
                return false;
            }
        }
        let pk = parent.kind();
        if pk.contains("parameter") || pk.contains("pattern") || is_type_like_parent(pk) {
            return false;
        }
        !self.is_qualified(node)
    }

    /// Member / label position: `obj.name`, `Foo::name`, `f(name = 1)`, Java `name()`…
    pub(crate) fn is_qualified(&self, node: &Node) -> bool {
        let parent = node.parent();
        let grandparent = parent.and_then(|p| p.parent());
        self.is_qualified_in(node, parent, grandparent)
    }

    /// [`Kinds::is_qualified`] with the ancestors already known (`Node::parent`
    /// walks down from the root, so hot loops pass them from a cursor).
    pub(crate) fn is_qualified_in(&self, node: &Node, parent: Option<Node>, grandparent: Option<Node>) -> bool {
        let Some(parent) = parent else { return false };
        let (field, prev, next) = neighbours(&parent, node);
        if let Some(prev) = prev
            && (matches!(prev.kind(), "." | "?." | "->" | "::" | "?->" | "!." | ".?" | "&." | "optional_chain")
                || (prev.kind() == ":" && parent.kind() == "method_index_expression"))
        {
            return true;
        }
        let member_field = |parent_kind: &str, field: Option<&str>| {
            self.table.member_fields.iter().any(|(pk, f)| *pk == parent_kind && (f.is_empty() || field == Some(*f)))
        };
        if member_field(parent.kind(), field) {
            return true;
        }
        // Single-child wrappers (`literal_element` around a Go key, `label` around a Dart name).
        if parent.named_child_count() == 1
            && let Some(gp) = grandparent
            && member_field(gp.kind(), neighbours(&gp, &parent).0)
        {
            return true;
        }
        next.is_some_and(|next| self.table.labels.iter().any(|(pk, tok)| *pk == parent.kind() && next.kind() == *tok))
    }
}

/// Field name of `child` in `parent`, and its previous / next sibling.
fn neighbours<'t>(parent: &Node<'t>, child: &Node<'t>) -> (Option<&'static str>, Option<Node<'t>>, Option<Node<'t>>) {
    let mut cursor = parent.walk();
    if !cursor.goto_first_child() {
        return (None, None, None);
    }
    let mut prev = None;
    loop {
        let n = cursor.node();
        if n == *child {
            let field = cursor.field_name();
            let next = if cursor.goto_next_sibling() { Some(cursor.node()) } else { None };
            return (field, prev, next);
        }
        prev = Some(n);
        if !cursor.goto_next_sibling() {
            return (None, None, None);
        }
    }
}

fn is_type_like(kind: &str) -> bool {
    [
        "class",
        "interface",
        "struct",
        "enum",
        "trait",
        "impl_item",
        "object_declaration",
        "object_definition",
        "record",
        "module",
        "namespace",
        "protocol",
        "extension",
        "mixin",
        "union",
        "template_body",
    ]
    .iter()
    .any(|k| kind.contains(k))
        && !kind.contains("expression")
}

fn is_type_like_parent(kind: &str) -> bool {
    kind.ends_with("_type") || kind == "type_arguments" || kind == "type_annotation" || kind == "user_type"
}

/// Field name of `node` in its parent.
pub(crate) fn field_name(node: &Node) -> Option<&'static str> {
    let parent = node.parent()?;
    let mut cursor = parent.walk();
    if !cursor.goto_first_child() {
        return None;
    }
    loop {
        if cursor.node() == *node {
            return cursor.field_name();
        }
        if !cursor.goto_next_sibling() {
            return None;
        }
    }
}

/// Comments, and string contents outside interpolations. `ancestors` runs from
/// the node's parent up to the root.
pub(crate) fn in_comment_or_string<'t>(node: &Node<'t>, ancestors: impl Iterator<Item = Node<'t>>) -> bool {
    if is_comment(node.kind()) {
        return true;
    }
    let mut child = *node;
    for n in ancestors {
        let kind = n.kind();
        if is_comment(kind) || (is_string(kind) && !is_code_in_string(child.kind())) {
            return true;
        }
        child = n;
    }
    false
}

pub(crate) fn is_comment(kind: &str) -> bool {
    kind.contains("comment")
}

fn is_string(kind: &str) -> bool {
    (kind.contains("string") || kind.contains("heredoc") || kind == "text_block" || kind.contains("char_literal"))
        && !kind.contains("interpolat")
}

fn is_code_in_string(kind: &str) -> bool {
    kind.contains("interpolat")
        || kind.contains("substitution")
        || kind.contains("expansion")
        || kind == "variable_name"
        || kind.ends_with("expression")
}
