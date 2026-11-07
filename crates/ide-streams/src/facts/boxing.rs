use super::Adjustment;
use super::locals::visible_local;
use super::rules::Collector;
use tree_sitter::Node;

impl<'t> Collector<'_, 't> {
    /// Rule 7: the evaluator stores a primitive element of `new Object[]{..}`
    /// unboxed outside lambdas, and a `(Object)` cast does not help.
    pub(super) fn box_primitives(&mut self, array: Node<'t>) {
        let is_object = array.child_by_field_name("type").is_some_and(|t| self.text(t) == "Object")
            && array.child_by_field_name("dimensions").is_some_and(|d| self.text(d) == "[]");
        let Some(init) = array.child_by_field_name("value").filter(|_| is_object) else { return };
        let mut cursor = init.walk();
        for element in init.named_children(&mut cursor) {
            if let Some(class) = self.box_class(element) {
                let text = self.text(element);
                self.replace(
                    element,
                    format!("{class}.valueOf({text})"),
                    Adjustment::PrimitiveBoxed { text: text.into() },
                );
            }
        }
    }

    fn box_class(&self, element: Node<'t>) -> Option<&'static str> {
        let text = self.text(element);
        let suffixed = |s: &[char]| text.ends_with(s);
        match element.kind() {
            "decimal_integer_literal" | "hex_integer_literal" | "octal_integer_literal" | "binary_integer_literal" => {
                Some(if suffixed(&['l', 'L']) { "Long" } else { "Integer" })
            }
            "decimal_floating_point_literal" | "hex_floating_point_literal" => {
                Some(if suffixed(&['f', 'F']) { "Float" } else { "Double" })
            }
            "character_literal" => Some("Character"),
            "true" | "false" => Some("Boolean"),
            "identifier" => {
                let ty = visible_local(self.t, element, self.member, text)?.ty?;
                match self.text(ty) {
                    "byte" => Some("Byte"),
                    "short" => Some("Short"),
                    "int" => Some("Integer"),
                    "long" => Some("Long"),
                    "char" => Some("Character"),
                    "float" => Some("Float"),
                    "double" => Some("Double"),
                    "boolean" => Some("Boolean"),
                    _ => None,
                }
            }
            _ => None,
        }
    }
}
