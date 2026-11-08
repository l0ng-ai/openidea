//! Conversions between JVM type signatures and the display names used by the class histogram.

const PRIMITIVES: [(char, &str); 9] = [
    ('B', "byte"),
    ('C', "char"),
    ('D', "double"),
    ('F', "float"),
    ('I', "int"),
    ('J', "long"),
    ('S', "short"),
    ('Z', "boolean"),
    ('V', "void"),
];

const BOXED: [&str; 8] = [
    "java.lang.Integer",
    "java.lang.Long",
    "java.lang.Short",
    "java.lang.Byte",
    "java.lang.Character",
    "java.lang.Boolean",
    "java.lang.Float",
    "java.lang.Double",
];

/// `None` for anything that is not a well-formed field descriptor.
pub fn signature_to_name(signature: &str) -> Option<String> {
    let base = signature.trim_start_matches('[');
    let dims = signature.len() - base.len();
    let mut chars = base.chars();
    let first = chars.next()?;
    let name = if first == 'L' {
        let class = base.strip_prefix('L')?.strip_suffix(';')?;
        if class.is_empty() || class.contains(';') {
            return None;
        }
        class.replace('/', ".")
    } else {
        if chars.next().is_some() || (first == 'V' && dims > 0) {
            return None;
        }
        PRIMITIVES.iter().find(|(c, _)| *c == first)?.1.to_string()
    };
    Some(name + &"[]".repeat(dims))
}

/// Inverse of [`signature_to_name`].
pub fn name_to_signature(name: &str) -> Option<String> {
    let mut base = name;
    let mut dims = 0;
    while let Some(rest) = base.strip_suffix("[]") {
        base = rest;
        dims += 1;
    }
    if base.is_empty() || base.contains(['[', ']', ';', '/']) {
        return None;
    }
    let element = match PRIMITIVES.iter().find(|(_, n)| *n == base) {
        Some((_, _)) if base == "void" && dims > 0 => return None,
        Some((c, _)) => c.to_string(),
        None => format!("L{};", base.replace('.', "/")),
    };
    Some("[".repeat(dims) + &element)
}

pub fn is_boxed(type_name: &str) -> bool {
    BOXED.contains(&type_name)
}

/// `coder` is `String.coder` (0 = Latin-1, 1 = UTF-16); JDK 8 strings have none and store one
/// `char` per element.
pub fn string_length(value_array_length: u32, coder: Option<u8>) -> u32 {
    match coder {
        Some(c) => value_array_length >> c.min(31),
        None => value_array_length,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_to_display_names() {
        for (sig, name) in [
            ("Lcom/x/Foo$Bar;", "com.x.Foo$Bar"),
            ("[I", "int[]"),
            ("[[Ljava/lang/String;", "java.lang.String[][]"),
            ("Z", "boolean"),
        ] {
            assert_eq!(signature_to_name(sig).as_deref(), Some(name));
            assert_eq!(name_to_signature(name).as_deref(), Some(sig));
        }
        assert_eq!(signature_to_name("Lbroken"), None);
    }

    #[test]
    fn string_length_follows_coder() {
        assert_eq!(string_length(10, Some(1)), 5);
        assert_eq!(string_length(10, Some(0)), 10);
        assert_eq!(string_length(7, None), 7);
    }

    #[test]
    fn boxed_types() {
        assert!(is_boxed("java.lang.Integer"));
        assert!(!is_boxed("java.lang.String"));
    }
}
