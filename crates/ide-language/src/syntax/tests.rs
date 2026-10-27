use super::*;
use crate::FoldKind;
use ide_core::{OutlineItem, Pos, SymbolKind, Visibility};

fn syntax() -> &'static Syntax {
    static S: OnceLock<Syntax> = OnceLock::new();
    S.get_or_init(Syntax::new)
}

fn lang(id: &str) -> LanguageId {
    LanguageId::new(id)
}

/// Renders an outline as indented `Kind name` lines.
fn render(items: &[OutlineItem]) -> String {
    fn go(items: &[OutlineItem], depth: usize, out: &mut String) {
        for i in items {
            out.push_str(&format!("{:indent$}{:?} {}\n", "", i.kind, i.name, indent = depth * 2));
            go(&i.children, depth + 1, out);
        }
    }
    let mut out = String::new();
    go(items, 0, &mut out);
    out
}

fn check_outline(id: &str, src: &str, expected: &str) {
    let actual = render(&syntax().outline(&lang(id), src));
    let expected = expected.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>();
    let base = expected.iter().map(|l| l.len() - l.trim_start().len()).min().unwrap_or(0);
    let expected: String = expected.iter().map(|l| format!("{}\n", &l[base..])).collect();
    assert_eq!(actual, expected, "outline for {id}:\n{actual}");
}

fn tags(id: &str, src: &str) -> Vec<(String, SymbolKind, Option<String>)> {
    syntax().tags(&lang(id), src).into_iter().map(|t| (t.name, t.kind, t.container)).collect()
}

fn has_tag(
    tags: &[(String, SymbolKind, Option<String>)],
    name: &str,
    kind: SymbolKind,
    container: Option<&str>,
) -> bool {
    tags.iter().any(|(n, k, c)| n == name && *k == kind && c.as_deref() == container)
}

fn folds(id: &str, src: &str) -> Vec<(u32, u32, FoldKind)> {
    syntax().folding(&lang(id), src).into_iter().map(|f| (f.start_line, f.end_line, f.kind)).collect()
}

#[test]
fn all_outline_queries_compile() {
    let mut errors = Vec::new();
    for g in &syntax().grammars {
        if let Err(e) = outline::OutlineQuery::new(&g.language, g.spec.outline) {
            errors.push(format!("{}: {e}", g.spec.name));
        }
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}

#[test]
fn every_grammar_parses_without_abi_errors() {
    for g in &syntax().grammars {
        assert!(parse(&g.language, "x", None).is_some(), "{} failed to parse", g.spec.name);
    }
}

#[test]
fn syntax_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Syntax>();
}

#[test]
fn supports_resolves_language_ids_and_grammar_names() {
    let s = syntax();
    for id in ["rust", "typescriptreact", "javascriptreact", "shellscript", "jsonc", "terraform", "makefile", "tsx"] {
        assert!(s.supports(&lang(id)), "{id}");
    }
    assert!(!s.supports(&lang("plaintext")));
    assert!(s.outline(&lang("plaintext"), "hello").is_empty());
    assert!(s.folding(&lang("nope"), "a\nb").is_empty());
    assert!(!s.fingerprint().is_empty());
    assert!(s.has_symbols(&lang("rust")));
    assert!(!s.has_symbols(&lang("json")));
    assert!(!s.has_symbols(&lang("markdown")));
    assert!(!s.has_symbols(&lang("plaintext")));
}

#[test]
fn user_languages_map_onto_bundled_grammars() {
    let cfg: crate::LanguageConfig =
        toml::from_str("id = \"mylang\"\nname = \"Mine\"\ntree-sitter = \"rust\"\n").unwrap();
    let missing: crate::LanguageConfig =
        toml::from_str("id = \"other\"\nname = \"Other\"\ntree-sitter = \"no-such-grammar\"\n").unwrap();
    let s = Syntax::with_languages(&[cfg, missing]);
    assert!(s.supports(&lang("mylang")));
    assert!(!s.supports(&lang("other")));
    assert_eq!(s.tags(&lang("mylang"), "fn a() {}").len(), 1);
}

#[test]
fn parallel_use_from_many_threads() {
    let src = "fn a() {}\nstruct B { x: i32 }\n";
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                for _ in 0..50 {
                    assert_eq!(syntax().tags(&lang("rust"), src).len(), 3);
                    assert_eq!(syntax().tags(&lang("python"), "def f():\n  pass\n").len(), 1);
                }
            });
        }
    });
}

// ---- outlines per language ----

#[test]
fn outline_rust() {
    let src = r#"
use std::fmt;

pub struct Foo<T> {
    a: i32,
    pub b: T,
}

enum E { A, B(i32) }

trait Tr {
    fn req(&self);
    fn prov(&self) {}
}

impl<T> Foo<T> {
    pub fn new() -> Self { todo!() }
    fn inner() {
        fn nested() {}
    }
}

impl fmt::Display for Foo<i32> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { Ok(()) }
}

mod m {
    pub const K: u32 = 1;
    macro_rules! mac { () => {} }
    type Alias = u8;
}

fn main() {}
"#;
    check_outline(
        "rust",
        src,
        "
        Struct Foo
          Field a
          Field b
        Enum E
          EnumMember A
          EnumMember B
        Trait Tr
          Method req
          Method prov
        Namespace impl Foo<T>
          Method new
          Method inner
            Function nested
        Namespace impl fmt::Display for Foo<i32>
          Method fmt
        Module m
          Constant K
          Macro mac
          TypeAlias Alias
        Function main
        ",
    );
    let t = tags("rust", src);
    assert!(has_tag(&t, "new", SymbolKind::Method, Some("Foo")));
    assert!(has_tag(&t, "fmt", SymbolKind::Method, Some("Foo")));
    assert!(has_tag(&t, "nested", SymbolKind::Function, Some("inner")));
    assert!(has_tag(&t, "K", SymbolKind::Constant, Some("m")));
    assert!(!t.iter().any(|(n, _, _)| n.starts_with("impl")), "impl blocks are not symbols");
}

#[test]
fn outline_ranges_are_utf16() {
    let src = "/* 😀 é */ fn café() {}\n";
    let items = syntax().outline(&lang("rust"), src);
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.name, "café");
    // "/* 😀 é */ " is 11 UTF-16 units (the emoji counts twice).
    assert_eq!(item.range.start, Pos::new(0, 11));
    assert_eq!(item.selection_range.start, Pos::new(0, 14));
    assert_eq!(item.selection_range.end, Pos::new(0, 18));
    assert_eq!(item.range.end, Pos::new(0, 23));
}

#[test]
fn outline_typescript() {
    let src = r#"
import { a } from "a";
export interface Shape {
  area(): number;
  name: string;
}
export class Circle implements Shape {
  private r = 1;
  constructor(r: number) { this.r = r; }
  area(): number { return 3 * this.r; }
  handler = () => {};
}
enum Color { Red, Green = 2 }
type Id = string;
namespace NS { export function f() {} }
export function top(x: number): void {}
export const arrow = (y: string) => y;
const K = 1;
let v = 2;
"#;
    check_outline(
        "typescript",
        src,
        "
        Interface Shape
          Method area
          Property name
        Class Circle
          Field r
          Constructor constructor
          Method area
          Method handler
        Enum Color
          EnumMember Red
          EnumMember Green
        TypeAlias Id
        Namespace NS
          Function f
        Function top
        Function arrow
        Constant K
        Variable v
        ",
    );
    let t = tags("typescript", src);
    assert!(has_tag(&t, "area", SymbolKind::Method, Some("Circle")));
    assert!(has_tag(&t, "Circle", SymbolKind::Class, None));
}

#[test]
fn outline_tsx_and_jsx() {
    let src = "export function App() {\n  return <div className=\"x\">\n    <Child />\n  </div>;\n}\nclass Widget extends React.Component { render() { return <span/>; } }\n";
    let expected = "
        Function App
        Class Widget
          Method render
        ";
    check_outline("typescriptreact", src, expected);
    check_outline("javascriptreact", src, expected);
    assert!(folds("typescriptreact", src).contains(&(0, 4, FoldKind::Region)));
}

#[test]
fn outline_javascript() {
    check_outline(
        "javascript",
        r#"
class A extends B {
  #priv = 1;
  constructor() { super(); }
  static s() {}
}
function f(a, b) {}
function* gen() {}
const g = () => {};
module.exports.k = function () {};
var old = 1;
"#,
        "
        Class A
          Field #priv
          Constructor constructor
          Method s
        Function f
        Function gen
        Function g
        Function k
        Variable old
        ",
    );
}

#[test]
fn outline_python() {
    let src = r#"
import os

X = 1

class Foo(Base):
    attr = 2

    def __init__(self, a):
        self.a = a

    @property
    def p(self):
        return 1

    class Inner:
        pass

def top(a, b=1):
    def nested():
        pass
    return nested
"#;
    check_outline(
        "python",
        src,
        "
        Variable X
        Class Foo
          Field attr
          Constructor __init__
          Method p
          Class Inner
        Function top
          Function nested
        ",
    );
    let t = tags("python", src);
    assert!(has_tag(&t, "p", SymbolKind::Method, Some("Foo")));
    assert!(has_tag(&t, "Inner", SymbolKind::Class, Some("Foo")));
}

#[test]
fn outline_go() {
    let src = r#"package main

import (
	"fmt"
)

type Server struct {
	Addr string
}

type Handler interface {
	Serve(w int) error
}

func (s *Server) Start() error { return nil }

func main() {}

const Version = "1"
"#;
    check_outline(
        "go",
        src,
        "
        Package main
        Struct Server
          Field Addr
        Interface Handler
          Method Serve
        Method Start
        Function main
        Constant Version
        ",
    );
    let t = tags("go", src);
    assert!(has_tag(&t, "Start", SymbolKind::Method, Some("Server")));
    assert!(has_tag(&t, "main", SymbolKind::Function, None));
}

#[test]
fn outline_java() {
    check_outline(
        "java",
        r#"
package com.x;
import java.util.List;
public class A extends B {
    private static final int K = 1;
    public A(String n) { }
    public void go(int x) {}
    enum Inner { X, Y }
    interface I { void m(); }
    record R(int a) {}
}
"#,
        "
        Class A
          Field K
          Constructor A
          Method go
          Enum Inner
            EnumMember X
            EnumMember Y
          Interface I
            Method m
          Class R
        ",
    );
}

#[test]
fn outline_kotlin() {
    check_outline(
        "kotlin",
        r#"package com.example

import a.b.C

class Foo(val x: Int) : Bar {
  val y = 1
  fun go(a: Int): Int {
    return a
  }
  companion object {
    const val K = 1
  }
}

object Single {
  fun f() {}
}

interface I {
  fun m()
}

enum class Color {
  RED, GREEN
}

fun top() = 1
"#,
        "
        Class Foo
          Property y
          Method go
          Class companion
            Property K
        Class Single
          Method f
        Interface I
          Method m
        Enum Color
          EnumMember RED
          EnumMember GREEN
        Function top
        ",
    );
}

#[test]
fn outline_scala() {
    check_outline(
        "scala",
        r#"package foo
class Foo(x: Int) extends Bar {
  val y = 1
  def go(a: Int): Int = a
}
object Single { def f(): Unit = () }
trait Tr { def m(): Int }
enum Color { case Red, Green }
"#,
        "
        Package foo
        Class Foo
          Field y
          Method go
        Class Single
          Method f
        Trait Tr
          Method m
        Enum Color
          EnumMember Red
          EnumMember Green
        ",
    );
}

#[test]
fn outline_c() {
    let src = "#include <stdio.h>\n#define MAX 10\nstruct point { int x; int *y; };\ntypedef struct point point_t;\nenum color { RED };\nint add(int a, int b);\nint add(int a, int b) {\n  return a + b;\n}\nchar *name(void) { return 0; }\n";
    check_outline(
        "c",
        src,
        "
        Macro MAX
        Struct point
          Field x
          Field y
        TypeAlias point_t
        Enum color
          EnumMember RED
        Function add
        Function add
        Function name
        ",
    );
}

#[test]
fn outline_cpp() {
    let src = r#"#include <vector>
namespace app {
class Widget : public Base {
public:
    Widget();
    void draw() const;
    int size;
};
Widget::Widget() {}
void Widget::draw() const {}
}
int main() { return 0; }
"#;
    check_outline(
        "cpp",
        src,
        "
        Namespace app
          Class Widget
            Constructor Widget
            Method draw
            Field size
          Constructor Widget
          Method draw
        Function main
        ",
    );
    let t = tags("cpp", src);
    assert!(has_tag(&t, "draw", SymbolKind::Method, Some("Widget")));
    assert_eq!(t.iter().filter(|(n, k, _)| n == "draw" && *k == SymbolKind::Method).count(), 2);
}

#[test]
fn outline_csharp() {
    check_outline(
        "csharp",
        r#"using System;
namespace Foo.Bar {
  public class C : B {
    private int x;
    public const int K = 1;
    public int P { get; set; }
    public C() {}
    public void Go(int a) {}
  }
  interface I { void M(); }
  enum E { A }
}
"#,
        "
        Namespace Foo.Bar
          Class C
            Field x
            Constant K
            Property P
            Constructor C
            Method Go
          Interface I
            Method M
          Enum E
            EnumMember A
        ",
    );
}

#[test]
fn outline_swift() {
    check_outline(
        "swift",
        r#"import Foundation
class Foo: Bar {
  var x: Int = 1
  init(x: Int) { self.x = x }
  func go(a: Int) -> Int { return a }
}
struct S { let y: Int }
protocol P { func m() }
extension Foo: P { func m() {} }
func top() {}
"#,
        "
        Class Foo
          Property x
          Constructor init
          Method go
        Struct S
          Property y
        Interface P
          Method m
        Namespace Foo
          Method m
        Function top
        ",
    );
    let t = tags("swift", "extension Foo { func m() {} }\n");
    assert!(has_tag(&t, "m", SymbolKind::Method, Some("Foo")));
}

#[test]
fn outline_ruby() {
    check_outline(
        "ruby",
        r#"module Billing
  class Invoice < Base
    attr_accessor :total
    VERSION = "1"
    def initialize(total)
      @total = total
    end
    def self.build
    end
  end
end
"#,
        "
        Module Billing
          Class Invoice
            Property total
            Constant VERSION
            Constructor initialize
            Method build
        ",
    );
}

#[test]
fn outline_php() {
    check_outline(
        "php",
        r#"<?php
namespace App;
class Foo extends Bar {
  const K = 1;
  private int $x = 1;
  public function __construct() {}
  public function go(int $a): int { return $a; }
}
interface I { function m(); }
trait T { function t() {} }
function top() {}
"#,
        "
        Namespace App
        Class Foo
          Constant K
          Property $x
          Constructor __construct
          Method go
        Interface I
          Method m
        Trait T
          Method t
        Function top
        ",
    );
}

#[test]
fn outline_lua() {
    let src =
        "local M = {}\nfunction M.go(a) return a end\nfunction M:method() end\nlocal function priv() end\nreturn M\n";
    check_outline(
        "lua",
        src,
        "
        Variable M
        Function go
        Method method
        Function priv
        ",
    );
    let t = tags("lua", src);
    assert!(has_tag(&t, "go", SymbolKind::Function, Some("M")));
}

#[test]
fn outline_bash() {
    check_outline(
        "shellscript",
        "#!/bin/bash\nNAME=foo\nbuild() {\n  echo hi\n}\nfunction deploy {\n  echo x\n}\n",
        "
        Variable NAME
        Function build
        Function deploy
        ",
    );
}

#[test]
fn outline_data_formats_are_outline_only() {
    let json = "{\n  \"name\": \"x\",\n  \"scripts\": {\n    \"build\": \"y\"\n  }\n}\n";
    check_outline(
        "json",
        json,
        "
        Key name
        Key scripts
          Key build
        ",
    );
    assert!(tags("json", json).is_empty());
    check_outline(
        "yaml",
        "on:\n  push:\n    branches: [main]\njobs:\n  build: {}\n",
        "
        Key on
          Key push
            Key branches
        Key jobs
          Key build
        ",
    );
    check_outline(
        "toml",
        "[package]\nname = \"x\"\n\n[[bin]]\nname = \"b\"\n",
        "
        Module package
          Key name
        Module bin
          Key name
        ",
    );
    check_outline(
        "markdown",
        "# Title\n\nIntro\n\n## A\n\ntext\n\n### Sub\n\n## B\n",
        "
        Key Title
          Key A
            Key Sub
          Key B
        ",
    );
    assert!(tags("markdown", "# Title\n").is_empty());
}

#[test]
fn outline_html_css_xml() {
    check_outline(
        "html",
        "<html>\n<body>\n  <div id=\"main\"><p>hi</p></div>\n  <script>let a = 1;</script>\n</body>\n</html>\n",
        "
        Field html
          Field body
            Field div
            Field script
        ",
    );
    check_outline(
        "css",
        ":root {\n  --accent: #fff;\n}\n.a, .b > c { color: red; }\n@media (max-width: 10px) {\n  .x { y: 1 }\n}\n",
        "
        Class :root
          Variable --accent
        Class .a, .b > c
        Namespace @media
          Class .x
        ",
    );
    check_outline(
        "xml",
        "<?xml version=\"1.0\"?>\n<project>\n  <dependencies>\n    <dependency/>\n  </dependencies>\n</project>\n",
        "
        Field project
          Field dependencies
            Field dependency
        ",
    );
}

#[test]
fn outline_more_languages() {
    check_outline(
        "dart",
        "class Foo {\n  int x = 1;\n  Foo(this.x);\n  int go(int a) { return a; }\n}\nvoid top() {}\n",
        "
        Class Foo
          Field x
          Constructor Foo
          Method go
        Function top
        ",
    );
    check_outline(
        "zig",
        "pub const Foo = struct {\n    x: i32,\n    pub fn go(self: Foo) i32 { return self.x; }\n};\nfn top() void {}\ntest \"basic\" {}\n",
        "
        Struct Foo
          Field x
          Method go
        Function top
        Function basic
        ",
    );
    check_outline(
        "elixir",
        "defmodule Foo.Bar do\n  def go(a), do: a\n  defp priv(b) do\n    b\n  end\n  defmacro m(x), do: x\nend\n",
        "
        Module Foo.Bar
          Function go
          Function priv
          Macro m
        ",
    );
    check_outline(
        "haskell",
        "module Foo where\ndata Shape = Circle Int | Square\nclass C a where\n  m :: a -> Int\ngo :: Int -> Int\ngo a = a\n",
        "
        Module Foo
        Enum Shape
          EnumMember Circle
          EnumMember Square
        Interface C
          Method m
        Function go
        ",
    );
    check_outline(
        "ocaml",
        "type t = { a : int }\nlet go x = x\nmodule M = struct\n  let inner y = y\nend\n",
        "
        Struct t
          Field a
        Function go
        Module M
          Function inner
        ",
    );
    check_outline(
        "ocaml.interface",
        "type t\nval go : int -> int\nmodule type S = sig val f : int -> int end\n",
        "
        TypeAlias t
        Function go
        Interface S
          Method f
        ",
    );
    check_outline(
        "terraform",
        "variable \"region\" {\n  default = \"us\"\n}\nresource \"aws_instance\" \"web\" {\n  ami = \"x\"\n}\n",
        "
        Struct variable.region
          Property default
        Struct resource.aws_instance.web
          Property ami
        ",
    );
    check_outline(
        "proto",
        "syntax = \"proto3\";\npackage foo.v1;\nmessage Foo {\n  int32 a = 1;\n  enum Kind { K0 = 0; }\n}\nservice Svc {\n  rpc Get(Foo) returns (Foo);\n}\n",
        "
        Package foo.v1
        Struct Foo
          Field a
          Enum Kind
            EnumMember K0
        Interface Svc
          Method Get
        ",
    );
    check_outline(
        "graphql",
        "type Query {\n  user(id: ID!): User\n}\nenum Role { ADMIN }\nquery GetUser { user(id: 1) { id } }\n",
        "
        Class Query
          Field user
        Enum Role
          EnumMember ADMIN
        Function GetUser
        ",
    );
    check_outline(
        "nix",
        "{ pkgs, ... }:\nlet\n  foo = 1;\n  bar = x: x;\nin { inherit foo; }\n",
        "
        Property foo
        Function bar
        ",
    );
    check_outline(
        "makefile",
        "CC := gcc\nall: build\nbuild: main.o\n\t$(CC) -o app main.o\n",
        "
        Variable CC
        Function all
        Function build
        ",
    );
    check_outline(
        "gdscript",
        "class_name Player\nextends Node\n\nsignal died\nenum State { IDLE, RUN }\nconst SPEED = 2\n@export var hp := 3\n\nfunc _init(a):\n\tpass\n\nfunc jump(height: float) -> void:\n\tvar local = 1\n\nclass Inner:\n\tvar x = 0\n\tfunc go():\n\t\tpass\n",
        "
        Class Player
        Event died
        Enum State
          EnumMember IDLE
          EnumMember RUN
        Constant SPEED
        Field hp
        Constructor _init
        Function jump
        Class Inner
          Field x
          Method go
        ",
    );
    check_outline(
        "cmake",
        "project(Foo)\nfunction(my_fn arg)\n  message(${arg})\nendfunction()\nadd_executable(app main.c)\n",
        "
        Module Foo
        Function my_fn
        Class app
        ",
    );
}

// ---- folding ----

#[test]
fn folding_rust() {
    let src = r#"use a;
use b::{
    c,
};

// one
// two
// three
fn f() {
    let v = vec![
        1,
    ];
}

/* block
   comment */
// region Helpers
fn g() {}
// endregion
"#;
    assert_eq!(
        folds("rust", src),
        vec![
            (0, 3, FoldKind::Imports),
            (1, 3, FoldKind::Region),
            (5, 7, FoldKind::Comment),
            (8, 12, FoldKind::Region),
            (9, 11, FoldKind::Region),
            (14, 15, FoldKind::Comment),
            (16, 18, FoldKind::Region),
        ]
    );
}

#[test]
fn folding_python_bodies_start_at_header() {
    let src = "import os\nimport sys\n\nclass A:\n    def f(self):\n        return [\n            1,\n        ]\n\n\ndef g():\n    pass\n";
    assert_eq!(
        folds("python", src),
        vec![
            (0, 1, FoldKind::Imports),
            (3, 7, FoldKind::Region),
            (4, 7, FoldKind::Region),
            (5, 7, FoldKind::Region),
            (10, 11, FoldKind::Region),
        ]
    );
}

#[test]
fn folding_data_and_markup() {
    assert_eq!(
        folds("json", "{\n  \"a\": [\n    1\n  ],\n  \"b\": {}\n}\n"),
        vec![(0, 5, FoldKind::Region), (1, 3, FoldKind::Region)]
    );
    assert_eq!(
        folds("yaml", "a:\n  b: 1\n  c:\n    - x\n    - y\nd: 2\n"),
        vec![(0, 4, FoldKind::Region), (2, 4, FoldKind::Region)]
    );
    assert_eq!(
        folds("html", "<div>\n  <!-- a\n  b -->\n  <p>x</p>\n</div>\n"),
        vec![(0, 4, FoldKind::Region), (1, 2, FoldKind::Comment)]
    );
    assert_eq!(
        folds("markdown", "# A\n\ntext\n\n```rust\nfn x() {}\n```\n\n# B\n\nmore\n"),
        vec![(0, 6, FoldKind::Region), (4, 6, FoldKind::Region), (8, 10, FoldKind::Region)]
    );
}

#[test]
fn folding_go_imports_and_ruby_ends() {
    assert_eq!(
        folds("go", "package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n)\n\nfunc main() {\n}\n"),
        vec![(2, 5, FoldKind::Imports), (7, 8, FoldKind::Region)]
    );
    assert_eq!(
        folds("ruby", "class A\n  def f\n    1\n  end\nend\n"),
        vec![(0, 4, FoldKind::Region), (1, 3, FoldKind::Region)]
    );
}

#[test]
fn folding_swift_control_flow_and_haskell_binds() {
    assert_eq!(
        folds("swift", "func f() {\n    if x {\n        g()\n    }\n    for i in xs {\n        g()\n    }\n}\n"),
        vec![(0, 7, FoldKind::Region), (1, 3, FoldKind::Region), (4, 6, FoldKind::Region)]
    );
    assert_eq!(
        folds("haskell", "main :: IO ()\nmain = do\n  putStrLn \"a\"\n  putStrLn \"b\"\n"),
        vec![(1, 3, FoldKind::Region)]
    );
}

#[test]
fn folds_are_unique_per_start_line_and_sorted() {
    for (id, src) in [
        ("typescript", "foo(function () {\n  bar([\n    1,\n  ]);\n});\n"),
        ("java", "class A {\n  void f() {\n    if (x) {\n    } else {\n    }\n  }\n}\n"),
    ] {
        let f = folds(id, src);
        assert!(f.windows(2).all(|w| w[0].0 < w[1].0), "{id}: {f:?}");
        assert!(f.iter().all(|(s, e, _)| s < e));
    }
}

// ---- selection ranges ----

fn sel_texts(id: &str, src: &str, caret: &str) -> Vec<String> {
    let at = src.find(caret).expect("caret marker");
    let src = src.replacen(caret, "", 1);
    let offset = src[..at].encode_utf16().count() as u32;
    let lines: Vec<&str> = src.split('\n').collect();
    let to_byte = |p: Pos| {
        let line_start: usize = lines[..p.line as usize].iter().map(|l| l.len() + 1).sum();
        let line = lines[p.line as usize];
        line_start + crate::syntax::lines::utf16_to_byte(line, p.col as usize)
    };
    syntax()
        .selection_ranges(&lang(id), &src, offset)
        .into_iter()
        .map(|r| src[to_byte(r.start)..to_byte(r.end)].to_owned())
        .collect()
}

#[test]
fn selection_ranges_rust_grow_outwards() {
    let src = "fn main() {\n    let total = compute(a + b|, c);\n}\n";
    let ranges = sel_texts("rust", src, "|");
    assert_eq!(ranges[0], "b");
    assert_eq!(ranges[1], "a + b");
    assert_eq!(ranges[2], "a + b, c");
    assert_eq!(ranges[3], "(a + b, c)");
    assert_eq!(ranges[4], "compute(a + b, c)");
    assert!(ranges.contains(&"let total = compute(a + b, c);".to_owned()));
    assert!(ranges.contains(&"{\n    let total = compute(a + b, c);\n}".to_owned()));
    assert_eq!(ranges.last().unwrap(), &src.replacen('|', "", 1));
    // Strictly growing.
    assert!(ranges.windows(2).all(|w| w[0].len() < w[1].len()));
}

#[test]
fn selection_ranges_words_inside_comments_and_strings() {
    let ranges = sel_texts("python", "x = \"hello wo|rld\"\n", "|");
    assert_eq!(&ranges[..3], &["world".to_owned(), "hello world".to_owned(), "\"hello world\"".to_owned()]);
    let ranges = sel_texts("rust", "// some com|ment text\nfn a() {}\n", "|");
    assert_eq!(ranges[0], "comment");
    assert_eq!(ranges[1], "// some comment text");
}

#[test]
fn selection_ranges_utf16_and_fallback() {
    let ranges = sel_texts("rust", "fn f() { let s = \"😀\"; let ab|c = 1; }\n", "|");
    assert_eq!(ranges[0], "abc");
    let ranges = sel_texts("plaintext", "one two\n  three fo|ur  \nfive\n", "|");
    assert_eq!(ranges, vec!["four", "three four", "  three four  ", "one two\n  three four  \nfive\n"]);
}

#[test]
fn caret_after_identifier_selects_it() {
    let ranges = sel_texts("typescript", "foo(bar|);\n", "|");
    assert_eq!(ranges[0], "bar");
}

#[test]
fn large_input_is_not_parsed() {
    let big = "a".repeat(MAX_PARSE_BYTES + 1);
    assert!(syntax().outline(&lang("rust"), &big).is_empty());
}

// --- web references -------------------------------------------------------------

fn web_defs(id: &str, src: &str) -> Vec<(String, SymbolKind, u32, u32)> {
    syntax()
        .web_definitions(&lang(id), src)
        .into_iter()
        .map(|t| (t.name, t.kind, t.range.start.line, t.range.start.col))
        .collect()
}

fn web_ref(id: &str, src: &str) -> Option<(WebReferenceKind, String, u32, u32)> {
    let at = src.find('|').expect("caret marker");
    let text = src.replace('|', "");
    let line = text[..at].matches('\n').count() as u32;
    let col = (at - text[..at].rfind('\n').map_or(0, |i| i + 1)) as u32;
    syntax()
        .web_reference_at(&lang(id), &text, Pos::new(line, col))
        .map(|r| (r.kind, r.name, r.range.start.col, r.range.end.col))
}

#[test]
fn web_definitions_of_stylesheets_and_style_elements() {
    let css = ".a.b, div#main > .c:hover { color: var(--x); --y: 1px; }\n@media (x) { .d {} }\n";
    assert_eq!(
        web_defs("css", css),
        vec![
            (".a".into(), CSS_CLASS, 0, 1),
            (".b".into(), CSS_CLASS, 0, 3),
            ("#main".into(), CSS_ID, 0, 10),
            (".c".into(), CSS_CLASS, 0, 18),
            ("--y".into(), CSS_VARIABLE, 0, 45),
            (".d".into(), CSS_CLASS, 1, 14),
        ]
    );
    // Pseudo-classes (`:hover`) are not classes; nested SCSS rules parse with the CSS grammar.
    assert!(!web_defs("css", css).iter().any(|d| d.0 == ".hover"));
    assert!(web_defs("scss", ".card { &:hover { } .title { } }").iter().any(|d| d.0 == ".title"));
    let html = "<p class=\"x\">\n<style>\n  .card { --gap: 2px }\n</style>";
    assert_eq!(web_defs("html", html), vec![(".card".into(), CSS_CLASS, 2, 3), ("--gap".into(), CSS_VARIABLE, 2, 10)]);
    assert!(syntax().tags(&lang("css"), css).iter().any(|t| t.name == ".a"));
    assert!(syntax().has_symbols(&lang("css")) && syntax().has_symbols(&lang("vue")));
}

#[test]
fn web_references_in_attributes_and_stylesheets() {
    use WebReferenceKind::*;
    assert_eq!(web_ref("html", r##"<div class="card bi|g">"##), Some((Class, "big".into(), 17, 20)));
    assert_eq!(web_ref("html", r##"<div class="|card big">"##), Some((Class, "card".into(), 12, 16)));
    assert_eq!(web_ref("html", r##"<div id="ma|in">"##), Some((Id, "main".into(), 9, 13)));
    assert_eq!(web_ref("html", r##"<a href="#to|p">"##), Some((Anchor, "top".into(), 9, 13)));
    assert_eq!(web_ref("html", r##"<a href="page.ht|ml">"##), None);
    assert_eq!(
        web_ref("html", r##"<p style="color: var(--ac|cent)">"##),
        Some((CssVariable, "--accent".into(), 21, 29))
    );
    assert_eq!(web_ref("html", "<style>\n.a { color: var(--x|) }\n</style>").map(|r| r.1), Some("--x".into()));
    assert_eq!(web_ref("css", ".a { color: var(--a|ccent, red) }"), Some((CssVariable, "--accent".into(), 16, 24)));
    assert_eq!(web_ref("css", ".a { color: re|d }"), None);
    assert_eq!(web_ref("vue", r##"<template><div class="ti|tle"/></template>"##).map(|r| r.0), Some(Class));
}

#[test]
fn web_anchors_find_ids_and_names() {
    let html = "<h2 id=\"top\">x</h2>\n<a name=\"top\"></a>\n<p class=\"top\">";
    let found: Vec<(u32, u32)> =
        syntax().web_anchors(&lang("html"), html, "top").into_iter().map(|r| (r.start.line, r.start.col)).collect();
    assert_eq!(found, vec![(0, 8), (1, 9)]);
}

#[test]
fn web_file_references_in_attributes_and_stylesheets() {
    let refs = |id: &str, src: &str| -> Vec<String> {
        syntax().web_file_references(&lang(id), src).into_iter().map(|r| r.value).collect()
    };
    let html = concat!(
        "<link href=\"css/a.css\"><img srcset=\"a.png 1x, b.png 2x\" src=img/c.png alt=\"x\">\n",
        "<a href=\"#top\" class=\"k\">t</a><div style=\"background: url(d.svg)\"></div>\n",
        "<style>@import \"e.css\"; .x { background: url('f.png') }</style>",
    );
    assert_eq!(refs("html", html), ["css/a.css", "a.png", "b.png", "img/c.png", "#top", "d.svg", "e.css", "f.png"]);
    assert_eq!(refs("css", "@import url(g.css);\n.y { mask: url(\"h.svg#i\") }"), ["g.css", "h.svg#i"]);
    let first = &syntax().web_file_references(&lang("html"), html)[0];
    assert_eq!((first.range.start.col, first.range.end.col), (12, 21));
}

#[test]
fn literals_are_outermost_comments_and_strings() {
    let src = "// note \"q\"\nfn main() { let s = \"a // b\"; /* c */ let c = 'x'; }\n";
    let found: Vec<(&str, LiteralKind)> =
        syntax().literals(&lang("rust"), src).unwrap().iter().map(|l| (&src[l.start..l.end], l.kind)).collect();
    assert_eq!(
        found,
        vec![
            ("// note \"q\"", LiteralKind::Comment),
            ("\"a // b\"", LiteralKind::String),
            ("/* c */", LiteralKind::Comment),
            ("'x'", LiteralKind::String),
        ]
    );
    assert!(syntax().literals(&lang("plaintext"), "// x").is_none());
}

/// `name: visibility` for every outline item, depth-first.
fn visibilities(id: &str, src: &str) -> Vec<(String, Option<Visibility>)> {
    fn go(items: &[OutlineItem], out: &mut Vec<(String, Option<Visibility>)>) {
        for i in items {
            out.push((i.name.clone(), i.visibility));
            go(&i.children, out);
        }
    }
    let mut out = Vec::new();
    go(&syntax().outline(&lang(id), src), &mut out);
    out
}

fn vis_of(list: &[(String, Option<Visibility>)], name: &str) -> Option<Visibility> {
    list.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no {name} in {list:?}")).1
}

#[test]
fn outline_visibility_rust() {
    let src = "pub struct S { a: i32, pub b: i32, pub(crate) c: i32 }\n\
               trait T { fn req(&self); }\n\
               impl T for S { fn req(&self) {} }\n\
               impl S { pub fn new() {} fn helper() {} }\n\
               fn main() {}\n";
    let v = visibilities("rust", src);
    assert_eq!(vis_of(&v, "S"), Some(Visibility::Public));
    assert_eq!(vis_of(&v, "a"), Some(Visibility::Private));
    assert_eq!(vis_of(&v, "b"), Some(Visibility::Public));
    assert_eq!(vis_of(&v, "c"), Some(Visibility::Package));
    assert_eq!(vis_of(&v, "new"), Some(Visibility::Public));
    assert_eq!(vis_of(&v, "helper"), Some(Visibility::Private));
    assert_eq!(vis_of(&v, "main"), Some(Visibility::Private));
    assert_eq!(vis_of(&v, "impl T for S"), None);
    // Trait members and trait impl members follow the trait.
    assert!(v.iter().filter(|(n, _)| n == "req").all(|(_, vis)| vis.is_none()));
}

#[test]
fn outline_visibility_java_ts_python() {
    let java = "public class A {\n  private int x;\n  protected void p() {}\n  void pkg() {}\n  public A() {}\n}\ninterface I { void m(); }\n";
    let v = visibilities("java", java);
    assert_eq!(vis_of(&v, "x"), Some(Visibility::Private));
    assert_eq!(vis_of(&v, "p"), Some(Visibility::Protected));
    assert_eq!(vis_of(&v, "pkg"), Some(Visibility::Package));
    assert_eq!(vis_of(&v, "A"), Some(Visibility::Public));
    assert_eq!(vis_of(&v, "m"), None);

    let ts = "class C {\n  private a = 1;\n  protected b(): void {}\n  c(): void {}\n  #d = 2;\n}\n";
    let v = visibilities("typescript", ts);
    assert_eq!(vis_of(&v, "a"), Some(Visibility::Private));
    assert_eq!(vis_of(&v, "b"), Some(Visibility::Protected));
    assert_eq!(vis_of(&v, "c"), None);
    assert_eq!(vis_of(&v, "#d"), Some(Visibility::Private));

    let py = "class K:\n    def _hidden(self): pass\n    def __init__(self): pass\n    def shown(self): pass\n";
    let v = visibilities("python", py);
    assert_eq!(vis_of(&v, "_hidden"), Some(Visibility::Private));
    assert_eq!(vis_of(&v, "__init__"), None);
    assert_eq!(vis_of(&v, "shown"), None);
}

#[test]
fn merge_visibility_matches_by_name_and_position() {
    fn clear(items: &mut [OutlineItem]) {
        for i in items {
            i.visibility = None;
            clear(&mut i.children);
        }
    }
    let src = "struct S { a: i32 }\nfn f() {}\n";
    let ts = syntax().outline(&lang("rust"), src);
    let mut lsp = ts.clone();
    clear(&mut lsp);
    lsp[1].name = "renamed".into();
    crate::merge_visibility(&mut lsp, &ts);
    assert_eq!(lsp[0].visibility, Some(Visibility::Private));
    assert_eq!(lsp[0].children[0].visibility, Some(Visibility::Private));
    assert_eq!(lsp[1].visibility, None);
}

#[test]
fn spelling_regions_cover_declared_names_only() {
    let src = "// note\nfn parse_input(raw_text: &str) -> Value { let mut counter = helper(raw_text); \"hi\" }\n";
    let found: Vec<(&str, SpellingKind)> =
        syntax().spelling_regions(&lang("rust"), src).unwrap().iter().map(|r| (&src[r.start..r.end], r.kind)).collect();
    assert_eq!(
        found,
        vec![
            ("// note", SpellingKind::Comment),
            ("parse_input", SpellingKind::Name),
            ("raw_text", SpellingKind::Name),
            ("counter", SpellingKind::Name),
            ("\"hi\"", SpellingKind::String),
        ]
    );
    let py = "def load_config(path, retries=3):\n    \"\"\"Doc.\"\"\"\n    total = 0\n";
    let names: Vec<&str> = syntax()
        .spelling_regions(&lang("python"), py)
        .unwrap()
        .iter()
        .filter(|r| r.kind == SpellingKind::Name)
        .map(|r| &py[r.start..r.end])
        .collect();
    assert_eq!(names, ["load_config", "path", "retries", "total"]);
    // Names in paths and calls are uses.
    let rs = "use crate::ui::keymap;\nfn run() { let n = std::ffi::OsStr::new(\"x\"); a::b::millis(); }\n";
    let names: Vec<&str> = syntax()
        .spelling_regions(&lang("rust"), rs)
        .unwrap()
        .iter()
        .filter(|r| r.kind == SpellingKind::Name)
        .map(|r| &rs[r.start..r.end])
        .collect();
    assert_eq!(names, ["run", "n"]);
}
