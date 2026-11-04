use super::*;
use crate::{JvmPresentation, JvmTypeKind::*, jvm_type_header};

fn presentation(language: &str, text: &str) -> JvmPresentation {
    service().jvm_presentation(&Snapshot::text(&lang(language), text), "Foo", &none()).unwrap()
}

#[test]
fn jvm_declaration_kinds() {
    for (language, source, kind) in [
        ("java", "public class Foo {}", Class),
        ("java", "abstract class Foo {}", AbstractClass),
        ("java", "interface Foo {}", Interface),
        ("java", "enum Foo { A }", Enum),
        ("java", "record Foo(int x) {}", Record),
        ("java", "@interface Foo {}", Annotation),
        ("java", "class Foo extends java.lang.RuntimeException {}", Exception),
        ("kotlin", "class Foo", Class),
        ("kotlin", "abstract class Foo", AbstractClass),
        ("kotlin", "interface Foo", Interface),
        ("kotlin", "enum class Foo { A }", Enum),
        ("kotlin", "annotation class Foo", Annotation),
        ("kotlin", "class Foo : RuntimeException()", Exception),
        ("kotlin", "object Foo {}", Object),
        ("kotlin", "data class Foo(val x: Int)", Class),
    ] {
        assert_eq!(presentation(language, source).kind, Some(kind), "{language}: {source}");
    }
}

#[test]
fn boot_annotations_are_on_the_primary_type_only() {
    for language in ["java", "kotlin"] {
        for annotation in ["@SpringBootApplication", "@org.springframework.boot.autoconfigure.SpringBootApplication"] {
            assert!(presentation(language, &format!("{annotation} class Foo {{}}")).spring_boot);
        }
        for source in [
            "// @SpringBootApplication\nclass Foo {}",
            "/* @SpringBootApplication */ class Foo {}",
            "@Service class Foo {}",
            "@Controller class Foo {}",
            "@Wrapper(\"@SpringBootApplication\") class Foo {}",
            "class Outer { @SpringBootApplication class Nested {} } class Foo {}",
        ] {
            assert!(!presentation(language, source).spring_boot, "{source}");
        }
    }
    assert!(!presentation("java", "class Foo { String s = \"@SpringBootApplication\"; }").spring_boot);
    assert!(!presentation("kotlin", "class Foo { val s = \"@SpringBootApplication\" }").spring_boot);
    assert!(!presentation("java", "class Foo { @SpringBootApplication void method() {} }").spring_boot);
    assert!(!presentation("java", "@Wrapper(@SpringBootApplication) class Foo {}").spring_boot);
    assert_eq!(presentation("java", "class Foo extends Box<RuntimeException> {}").kind, Some(Class));
    assert_eq!(presentation("kotlin", "class Foo : Box<RuntimeException>()").kind, Some(Class));
    assert_eq!(presentation("java", "// no type\n"), JvmPresentation::default());
    assert_eq!(presentation("kotlin", "val text = \"class Foo\""), JvmPresentation::default());
    assert_eq!(presentation("java", "interface Other {} class Foo {} ").kind, Some(Class));
}

#[test]
fn runnable_methods() {
    assert!(presentation("java", "class Foo { public static void main(String[] args) {} }").runnable);
    assert!(presentation("java", "class Foo { public static void main(String... args) {} }").runnable);
    assert!(!presentation("java", "class Foo { void main() {} }").runnable);
    assert!(!presentation("java", "class Foo { class Nested { public static void main(String[] a) {} } }").runnable);
    assert!(!presentation("java", "class Foo { String s = \"public static void main(String[] args) {}\"; }").runnable);
    assert!(
        presentation(
            "kotlin",
            "class Foo {
 companion object {
 @JvmStatic
 fun main(args: Array<String>) {}
 }
 }"
        )
        .runnable
    );
}

#[test]
fn a_cut_off_file_is_classified_by_its_type_header() {
    for (source, header) in [
        (
            "package a.record;\n/* class { */\n@Ann({\"}\"}) // interface {\npublic class Foo implements IFoo {\n  void m() {",
            "package a.record;\n/* class { */\n@Ann({\"}\"}) // interface {\npublic class Foo implements IFoo {",
        ),
        ("@interface Foo { String value() default \"{\";", "@interface Foo {"),
        (
            "class Foo(val a: Map<String, () -> Unit> = mapOf()) : Base() {\n  fun f() {",
            "class Foo(val a: Map<String, () -> Unit> = mapOf()) : Base() {",
        ),
        (
            "record Foo(int x) implements Comparable<Foo> {\n  static String S = \"\"\"\n {",
            "record Foo(int x) implements Comparable<Foo> {",
        ),
    ] {
        assert_eq!(jvm_type_header(source), Some(header), "{source}");
    }
    assert_eq!(jvm_type_header("package a;\nimport b.C;\n/* unterminated class {"), None);

    let cut = "@Service\npublic abstract class Foo extends Base {\n  void m() {\n    /*\n     * doc";
    assert_eq!(presentation("java", cut).kind, None, "the cut-off text itself doesn't parse");
    let closed = format!("{}}}", jvm_type_header(cut).unwrap());
    assert_eq!(presentation("java", &closed).kind, Some(AbstractClass));
}
