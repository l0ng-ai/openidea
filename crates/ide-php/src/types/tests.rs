use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::*;
use crate::names::RelativeClass;
use crate::summary::{DocBlock, DocType, FileSummary, TypeHint};
use crate::syntax::ParsedFile;

fn parse(text: &str) -> Type {
    parse_with(text, &["T", "TKey"])
}

fn parse_with(text: &str, templates: &[&str]) -> Type {
    parse_doc_type(text, templates).unwrap_or_else(|error| panic!("`{text}`: {error}"))
}

/// Parse, then display: (input, displayed).
#[test]
fn parse_and_display_table() {
    let table: &[(&str, &str)] = &[
        // Keywords and scalars.
        ("int", "int"),
        ("integer", "int"),
        ("float", "float"),
        ("double", "float"),
        ("string", "string"),
        ("bool", "bool"),
        ("boolean", "bool"),
        ("true", "true"),
        ("false", "false"),
        ("null", "null"),
        ("void", "void"),
        ("never", "never"),
        ("noreturn", "never"),
        ("mixed", "mixed"),
        ("object", "object"),
        ("resource", "resource"),
        ("scalar", "scalar"),
        ("numeric", "numeric"),
        ("array-key", "array-key"),
        ("number", "int|float"),
        // Refinements and literals.
        ("positive-int", "positive-int"),
        ("non-negative-int", "non-negative-int"),
        ("negative-int", "negative-int"),
        ("non-positive-int", "non-positive-int"),
        ("int<0, 100>", "int<0, 100>"),
        ("int<min, 5>", "int<min, 5>"),
        ("int<-5, max>", "int<-5, max>"),
        ("int<min, max>", "int"),
        ("int<3, 3>", "3"),
        ("non-empty-string", "non-empty-string"),
        ("numeric-string", "numeric-string"),
        ("non-falsy-string", "non-falsy-string"),
        ("truthy-string", "non-falsy-string"),
        ("lowercase-string", "lowercase-string"),
        ("callable-string", "callable-string"),
        ("literal-string", "string"),
        ("42", "42"),
        ("-7", "-7"),
        ("1.5", "1.5"),
        ("'foo'", "'foo'"),
        ("\"bar\"", "'bar'"),
        (r"'it\'s'", r"'it\'s'"),
        // Arrays, lists, shapes and iterables.
        ("array", "array"),
        ("array<int>", "int[]"),
        ("array<string, int>", "array<string, int>"),
        ("array<int|string>", "array<int|string>"),
        ("non-empty-array<int>", "non-empty-array<int>"),
        ("non-empty-array", "non-empty-array"),
        (r"\Foo[]", "Foo[]"),
        ("int[][]", "int[][]"),
        ("list", "list"),
        ("list<string>", "list<string>"),
        ("non-empty-list<int>", "non-empty-list<int>"),
        ("array{a: int, b?: string}", "array{a: int, b?: string}"),
        ("array{int, string}", "array{int, string}"),
        ("array{'a b': int, 3: bool}", "array{'a b': int, 3: bool}"),
        ("list{int, string}", "list{int, string}"),
        ("array{a: int, ...}", "array{a: int, ...}"),
        ("array{a: int, ...<string, int>}", "array{a: int, ...<string, int>}"),
        ("list{int, ...<string>}", "list{int, ...<string>}"),
        ("array{}", "array{}"),
        ("iterable", "iterable"),
        ("iterable<int>", "iterable<int>"),
        ("iterable<string, int>", "iterable<string, int>"),
        // Classes, generics, relative types and templates.
        (r"\App\Model\Book", r"App\Model\Book"),
        (r"\App\Collection<int, \App\Book>", r"App\Collection<int, App\Book>"),
        (r"\Generator<int, string, mixed, void>", "Generator<int, string, mixed, void>"),
        ("self", "self"),
        ("static", "static"),
        ("parent", "parent"),
        ("$this", "$this"),
        ("T", "T"),
        ("array<TKey, T>", "array<TKey, T>"),
        ("class-string", "class-string"),
        ("class-string<T>", "class-string<T>"),
        (r"class-string<\App\Book>", r"class-string<App\Book>"),
        ("interface-string", "class-string"),
        (r"\App\Suit::Hearts", r"App\Suit::Hearts"),
        // Unions, intersections and nullable types.
        ("?int", "?int"),
        (r"?\App\Book", r"?App\Book"),
        ("int|null", "?int"),
        ("null|string", "?string"),
        ("int|string|null", "int|string|null"),
        (r"\A&\B", "A&B"),
        (r"(\A&\B)|null", "(A&B)|null"),
        (r"(\A&\B)|\C", "(A&B)|C"),
        (r"\A&(\B|\C)", "A&(B|C)"),
        ("(int)", "int"),
        // Callables.
        ("callable", "callable"),
        ("callable(): void", "callable(): void"),
        ("callable(int, string): bool", "callable(int, string): bool"),
        ("callable(int=): mixed", "callable(int=): mixed"),
        ("callable(int ...$rest): void", "callable(int ...$rest): void"),
        ("callable(int &$out): void", "callable(int &$out): void"),
        ("callable(int): (int|null)", "callable(int): ?int"),
        ("callable(int): ?int", "callable(int): ?int"),
        ("callable(): (int|string)", "callable(): (int|string)"),
        (r"\Closure", "Closure"),
        ("Closure(T): bool", "Closure(T): bool"),
        ("(callable(int): void)|null", "(callable(int): void)|null"),
        // Approximated forms.
        ("(T is int ? string : bool)", "string|bool"),
        ("key-of<T>", "array-key"),
        ("value-of<T>", "mixed"),
        ("int-mask<1, 2, 4>", "int"),
    ];
    let mut failures = Vec::new();
    for (input, expected) in table {
        match parse_doc_type(input, &["T", "TKey"]) {
            Ok(ty) if ty.to_string() == *expected => {}
            Ok(ty) => failures.push(format!("{input}: got `{ty}` ({ty:?}), want `{expected}`")),
            Err(error) => failures.push(format!("{input}: {error}")),
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// The displayed type parses back to the same type.
#[test]
fn display_round_trips() {
    for input in [
        "int<0, 100>|non-empty-string|null",
        r"array{a: \App\Book, b?: list<int>, ...<string, mixed>}",
        r"\App\Collection<int, \App\Book>",
        "callable(int, string=, mixed ...$rest): (int|false)",
        "Closure(T): bool",
        r"(\A&\B)|null",
        "'a\\'b'",
        "array<array-key, int>",
        "list{int, string}",
        "array{0: int, 1?: string}",
        "-3|1.5|true",
    ] {
        let ty = parse(input);
        let again = parse(&ty.to_string());
        assert_eq!(again, ty, "{input} → {ty}");
    }
}

#[test]
fn parsed_structure() {
    assert_eq!(
        parse(r"\App\Collection<int, T>"),
        Type::generic("App\\Collection", vec![Type::Int, Type::Template("T".into())])
    );
    assert_eq!(parse("?int"), Type::Union(vec![Type::Int, Type::Null]));
    assert_eq!(parse("array{int, 5: bool, string}"), {
        let field = |key, ty| ShapeField { key: ShapeKey::Int(key), ty, optional: false };
        Type::Shape(Box::new(Shape {
            list: false,
            fields: vec![field(0, Type::Int), field(5, Type::Bool), field(6, Type::string())],
            rest: None,
        }))
    });
    // An unqualified name that is not a template stays a class name.
    assert_eq!(parse_with("Foo", &[]), Type::named("Foo"));
    assert_eq!(parse_with("T", &[]), Type::named("T"));
    // Template names are case-sensitive.
    assert_eq!(parse_with("t", &["T"]), Type::named("t"));
    assert_eq!(parse("callable(int =$x): void").to_string(), "callable(int =$x): void");
    assert_eq!(parse("callable(int =$x): void"), {
        Type::Callable(Some(Box::new(Signature {
            params: vec![SignatureParam {
                ty: Type::Int,
                name: Some("x".into()),
                by_ref: false,
                optional: true,
                variadic: false,
            }],
            return_type: Some(Type::Void),
        })))
    });
    assert_eq!(parse("new<class-string<T>>"), Type::Template("T".into()));
}

#[test]
fn invalid_doc_types() {
    for input in ["", "   ", "array<", "|int", "array{a: }", "int string"] {
        assert!(parse_doc_type(input, &[]).is_err(), "{input:?} parsed");
    }
    assert_eq!(Type::from_doc(&DocType("array<".into()), &[]), Type::Mixed);
    assert_eq!(Type::from_doc(&DocType(r"list<\App\Book>".into()), &[]), Type::list_of(Type::named("App\\Book")));
}

#[test]
fn native_hints() {
    let named = |name: &str| TypeHint::Named(name.into());
    let builtin = |name: &str| TypeHint::Builtin(name.into());
    let table: &[(TypeHint, &str)] = &[
        (builtin("int"), "int"),
        (builtin("array"), "array"),
        (builtin("iterable"), "iterable"),
        (builtin("callable"), "callable"),
        (builtin("false"), "false"),
        (builtin("never"), "never"),
        (builtin("mixed"), "mixed"),
        (builtin("object"), "object"),
        (named("App\\Book"), "App\\Book"),
        (named("Closure"), "Closure"),
        (TypeHint::Relative(RelativeClass::Static), "static"),
        (TypeHint::Nullable(Box::new(named("App\\Book"))), "?App\\Book"),
        (TypeHint::Union(vec![builtin("int"), builtin("string"), builtin("null")]), "int|string|null"),
        (TypeHint::Union(vec![builtin("true"), builtin("false")]), "bool"),
        (TypeHint::Union(vec![TypeHint::Intersection(vec![named("A"), named("B")]), builtin("null")]), "(A&B)|null"),
        (TypeHint::Nullable(Box::new(builtin("mixed"))), "mixed"),
    ];
    for (hint, expected) in table {
        assert_eq!(Type::from_hint(hint).to_string(), *expected, "{hint:?}");
    }
}

/// Union and intersection simplification: (input, simplified).
#[test]
fn simplification_table() {
    let table: &[(&str, &str)] = &[
        ("int|int", "int"),
        ("int|string|int", "int|string"),
        ("true|false", "bool"),
        ("true|int|false", "bool|int"),
        ("true|bool", "bool"),
        ("1|int", "int"),
        ("int|positive-int|3", "int"),
        ("positive-int|1", "positive-int"),
        ("'a'|string", "string"),
        ("non-empty-string|string", "string"),
        ("numeric-string|non-empty-string", "non-empty-string"),
        ("int|mixed", "mixed"),
        ("never|int", "int"),
        ("int|(string|null)", "int|string|null"),
        ("int|array-key", "array-key"),
        ("list<int>|array", "array"),
        ("int[]|array<int, int>", "int[]"),
        (r"\A|\B|\A", "A|B"),
        (r"\Closure|callable", "callable"),
        ("T|int", "T|int"),
        (r"\A&\A", "A"),
        (r"\A&mixed", "A"),
        (r"\A&never", "never"),
        ("int&positive-int", "positive-int"),
        (r"\A&(\B&\C)", "A&B&C"),
    ];
    let mut failures = Vec::new();
    for (input, expected) in table {
        let ty = parse(input);
        if ty.to_string() != *expected {
            failures.push(format!("{input}: got `{ty}`, want `{expected}`"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    assert_eq!(Type::union([]), Type::Never);
    assert_eq!(Type::intersection([]), Type::Mixed);
    assert_eq!(Type::Int.nullable().without_null(), Type::Int);
    assert!(parse("?int").is_nullable() && !parse("int").is_nullable() && Type::Mixed.is_nullable());
}

/// A hierarchy from a list of (class, parents).
struct Classes(HashMap<String, Vec<String>>);

impl Classes {
    fn new(edges: &[(&str, &[&str])]) -> Self {
        Self(
            edges
                .iter()
                .map(|(class, parents)| {
                    (class.to_ascii_lowercase(), parents.iter().map(|parent| parent.to_ascii_lowercase()).collect())
                })
                .collect(),
        )
    }
}

impl Hierarchy for Classes {
    fn is_subclass(&self, sub: &str, sup: &str) -> bool {
        let (sub, sup) = (sub.to_ascii_lowercase(), sup.to_ascii_lowercase());
        sub == sup
            || self.0.get(&sub).is_some_and(|parents| parents.iter().any(|parent| self.is_subclass(parent, &sup)))
    }
}

/// (sub, super, expected).
#[test]
fn subtyping_table() {
    let classes = Classes::new(&[
        ("App\\Book", &["App\\Model", "Stringable"]),
        ("App\\Model", &["App\\Entity"]),
        ("App\\Collection", &["IteratorAggregate", "Countable"]),
        ("IteratorAggregate", &["Traversable"]),
        ("App\\Suit", &["UnitEnum"]),
    ]);
    let table: &[(&str, &str, bool)] = &[
        // Top and bottom.
        ("int", "mixed", true),
        ("mixed", "int", false),
        ("never", r"\App\Book", true),
        ("int", "never", false),
        ("void", "void", true),
        ("null", "void", false),
        // Scalars and refinements.
        ("true", "bool", true),
        ("bool", "true", false),
        ("bool", "true|false", true),
        ("5", "int", true),
        ("5", "positive-int", true),
        ("0", "positive-int", false),
        ("int<1, 10>", "int<0, 100>", true),
        ("int<1, max>", "int<0, 100>", false),
        ("positive-int", "non-negative-int", true),
        ("int", "positive-int", false),
        ("int", "float", false),
        ("1.5", "float", true),
        ("'abc'", "non-empty-string", true),
        ("''", "non-empty-string", false),
        ("'0'", "non-falsy-string", false),
        ("'12.5e3'", "numeric-string", true),
        ("' 42'", "numeric-string", true),
        ("'4x'", "numeric-string", false),
        ("'abc'", "lowercase-string", true),
        ("'Abc'", "lowercase-string", false),
        ("non-empty-lowercase-string", "lowercase-string", true),
        ("non-falsy-string", "non-empty-string", true),
        ("non-empty-string", "non-falsy-string", false),
        ("numeric-string", "numeric", true),
        ("int", "array-key", true),
        ("'k'", "array-key", true),
        ("float", "array-key", false),
        ("array-key", "int|string", true),
        ("array-key", "scalar", true),
        ("scalar", "int|string|float|bool", true),
        ("numeric", "int|float|string", true),
        ("float", "scalar", true),
        ("null", "scalar", false),
        ("class-string", "string", true),
        ("class-string", "non-empty-string", true),
        (r"class-string<\App\Book>", r"class-string<\App\Model>", true),
        (r"class-string<\App\Model>", r"class-string<\App\Book>", false),
        (r"class-string<\App\Book>", "class-string", true),
        ("string", "class-string", false),
        // Nullable, unions and intersections.
        ("int", "?int", true),
        ("null", "?int", true),
        ("?int", "int", false),
        ("int|string", "int|string|null", true),
        ("int|string", "int", false),
        (r"\App\Book&\Countable", r"\App\Model", true),
        (r"\App\Book", r"\App\Model&\Stringable", true),
        (r"\App\Model", r"\App\Book&\Stringable", false),
        // Classes and generics.
        (r"\App\Book", r"\App\Entity", true),
        (r"\App\Entity", r"\App\Book", false),
        (r"\App\Book", "object", true),
        ("object", r"\App\Book", false),
        (r"\App\Collection<\App\Book>", r"\App\Collection<\App\Model>", true),
        (r"\App\Collection<\App\Model>", r"\App\Collection<\App\Book>", false),
        (r"\App\Collection", r"\App\Collection<int>", true),
        (r"\App\Collection<int>", r"\App\Collection", true),
        (r"\App\Collection<int>", "iterable", true),
        (r"\App\Book", "iterable", false),
        (r"\App\Suit::Hearts", r"\App\Suit::Hearts", true),
        // Relative types and templates.
        ("$this", "static", true),
        ("static", "self", true),
        ("self", "static", false),
        ("static", "object", true),
        ("T", "T", true),
        ("T", "int", false),
        ("int", "T", false),
        ("T", "T|null", true),
        // Arrays, lists, shapes and iterables.
        ("array<int, string>", "array", true),
        ("array", "array<int, string>", false),
        ("list<int>", "array<int, int>", true),
        ("list<int>", "array<string, int>", false),
        ("array<int, int>", "list<int>", false),
        ("non-empty-list<int>", "list<int>", true),
        ("list<int>", "non-empty-list<int>", false),
        ("non-empty-array<int>", "array<int>", true),
        ("array{a: int, b: string}", "array<string, int|string>", true),
        ("array{a: int, b: string}", "array<string, int>", false),
        ("array{a: int}", "non-empty-array<string, int>", true),
        ("array{a?: int}", "non-empty-array<string, int>", false),
        ("list{int, string}", "list<int|string>", true),
        ("array{int, string}", "list<int|string>", false),
        ("array{a: int, b: string}", "array{a: int}", false),
        ("array{a: int, b: string}", "array{a: int, ...}", true),
        ("array{a: int}", "array{a: int, b?: string}", true),
        ("array{a: int}", "array{a: int, b: string}", false),
        ("array{a?: int}", "array{a: int}", false),
        ("array{a: positive-int}", "array{a: int}", true),
        ("array{a: int, ...}", "array{a: int}", false),
        ("array<string>", "iterable<string>", true),
        ("list<int>", "iterable<int, int>", true),
        ("array<string, int>", "iterable<int, int>", false),
        ("iterable<int>", "array<int>", false),
        // Callables and closures.
        ("Closure", "callable", true),
        ("callable", "Closure", false),
        ("Closure", "object", true),
        (r"\Closure", r"\Closure", true),
        ("callable-string", "callable", true),
        ("callable(int): string", "callable", true),
        ("callable", "callable(int): string", true),
        ("callable(int): string", "callable(int): string", true),
        ("callable(int): non-empty-string", "callable(int): string", true),
        ("callable(int): string", "callable(int): int", false),
        ("callable(int|string): void", "callable(int): void", true),
        ("callable(int): void", "callable(int|string): void", false),
        ("callable(): int", "callable(int): void", true),
        ("callable(int, int): void", "callable(int): void", false),
        ("callable(int, int=): void", "callable(int): void", true),
        ("callable(int ...$xs): void", "callable(int, int): void", true),
        ("Closure(int): int", "callable(int): int", true),
        ("callable(int): int", "Closure(int): int", false),
    ];
    let mut failures = Vec::new();
    for (a, b, expected) in table {
        let (ta, tb) = (parse(a), parse(b));
        if ta.is_subtype_of(&tb, &classes) != *expected {
            failures.push(format!("{a} <: {b} should be {expected}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn types_serialize() {
    let ty = parse(r"array{a: \App\Book, b?: callable(int): void}|class-string<T>|null");
    let bytes = postcard::to_allocvec(&ty).expect("serialize");
    assert_eq!(postcard::from_bytes::<Type>(&bytes).expect("deserialize"), ty);
}

fn php_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).expect("read dir").map(|e| e.expect("entry").path()).collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name != "vendor") {
                php_files(&path, out);
            }
        } else if path.extension().is_some_and(|ext| ext == "php") {
            out.push(path);
        }
    }
}

/// Every PHPDoc type in a docblock with the template names in scope.
fn doc_types<'d>(doc: &'d DocBlock, outer: &[String], out: &mut Vec<(Vec<String>, &'d DocType)>) {
    let mut names = outer.to_vec();
    names.extend(doc.templates.iter().map(|template| template.name.clone()));
    let types = doc
        .vars
        .iter()
        .map(|var| &var.ty)
        .chain(doc.params.iter().map(|param| &param.ty))
        .chain(doc.return_type.iter())
        .chain(doc.throws.iter())
        .chain(doc.templates.iter().flat_map(|template| template.bound.iter().chain(template.default.iter())))
        .chain(doc.extends.iter())
        .chain(doc.implements.iter())
        .chain(doc.uses.iter())
        .chain(doc.mixins.iter())
        .chain(doc.properties.iter().filter_map(|property| property.ty.as_ref()));
    out.extend(types.map(|ty| (names.clone(), ty)));
    for method in &doc.methods {
        let mut names = names.clone();
        names.extend(method.templates.iter().map(|template| template.name.clone()));
        for ty in method.return_type.iter().chain(method.params.iter().filter_map(|param| param.ty.as_ref())) {
            out.push((names.clone(), ty));
        }
    }
}

/// Every PHPDoc type in fixtures/php-app parses, and the templated
/// collection's types name its template parameter.
#[test]
fn php_app_fixture_doc_types_parse() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/php-app");
    let mut files = Vec::new();
    php_files(&root, &mut files);
    let summaries: Vec<FileSummary> = files
        .iter()
        .map(|path| {
            let text = std::fs::read_to_string(path).expect("read fixture");
            FileSummary::extract(&ParsedFile::parse(&path.to_string_lossy(), text.as_str()))
        })
        .collect();

    let mut all = Vec::new();
    let mut templated = Vec::new();
    for summary in &summaries {
        for class in &summary.class_likes {
            let class_names: Vec<String> =
                class.doc.iter().flat_map(|doc| doc.templates.iter()).map(|t| t.name.clone()).collect();
            if let Some(doc) = &class.doc {
                doc_types(doc, &[], &mut all);
            }
            let member_docs = class
                .methods
                .iter()
                .map(|method| &method.doc)
                .chain(class.properties.iter().map(|property| &property.doc))
                .chain(class.constants.iter().map(|constant| &constant.doc));
            for doc in member_docs.flatten() {
                let before = all.len();
                doc_types(doc, &class_names, &mut all);
                if !class_names.is_empty() {
                    templated.extend(all[before..].iter().map(|(_, ty)| ty.as_str().to_owned()));
                }
            }
            for method in &class.methods {
                for hint in method.params.iter().filter_map(|param| param.type_hint.as_ref()).chain(&method.return_type)
                {
                    let declared_mixed = matches!(hint, TypeHint::Builtin(name) if name == "mixed");
                    assert_eq!(Type::from_hint(hint) == Type::Mixed, declared_mixed, "{hint:?}");
                }
            }
        }
        for function in &summary.functions {
            if let Some(doc) = &function.doc {
                doc_types(doc, &[], &mut all);
            }
        }
    }
    assert!(all.len() >= 10, "only {} doc types in the fixture", all.len());
    let mut failures = Vec::new();
    for (names, ty) in &all {
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        if let Err(error) = parse_doc_type(ty.as_str(), &names) {
            failures.push(format!("{ty}: {error}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    assert!(!templated.is_empty(), "the fixture has a templated class");

    // `Collection<T>`'s members mention `T` as a template parameter.
    let collection = summaries
        .iter()
        .flat_map(|summary| &summary.class_likes)
        .find(|class| class.name == "Collection")
        .expect("fixture Collection");
    let names: Vec<&str> =
        collection.doc.iter().flat_map(|doc| doc.templates.iter()).map(|template| template.name.as_str()).collect();
    assert!(!names.is_empty());
    let mentions_template = collection
        .methods
        .iter()
        .filter_map(|method| method.doc.as_ref())
        .flat_map(|doc| doc.params.iter().map(|param| &param.ty).chain(doc.return_type.iter()))
        .any(|ty| mentions(&Type::from_doc(ty, &names), names[0]));
    assert!(mentions_template, "no Collection member type uses its template");
}

fn mentions(ty: &Type, template: &str) -> bool {
    match ty {
        Type::Template(name) => name == template,
        Type::Named { args, .. } => args.iter().any(|arg| mentions(arg, template)),
        Type::Array { key, value, .. } | Type::Iterable { key, value } => {
            mentions(key, template) || mentions(value, template)
        }
        Type::List { value, .. } => mentions(value, template),
        Type::ClassString(Some(inner)) => mentions(inner, template),
        Type::Union(members) | Type::Intersection(members) => members.iter().any(|member| mentions(member, template)),
        Type::Callable(Some(signature)) | Type::Closure(Some(signature)) => {
            signature.params.iter().any(|param| mentions(&param.ty, template))
                || signature.return_type.as_ref().is_some_and(|ty| mentions(ty, template))
        }
        _ => false,
    }
}
