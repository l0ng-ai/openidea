//! Class names in the form the JVM's class histogram and the UI use.

/// The Java source form of an hprof class name (`java/util/HashMap$Node`, `[Ljava/lang/String;`),
/// as `ide_jvm_attach::display_class_name` writes it, plus `+0x` → `/0x` for hidden classes,
/// which the histogram spells with a slash. Names that already use dots pass through unchanged.
pub fn display_name(hprof_name: &str) -> String {
    let dotted = hprof_name.replace('/', ".");
    let dims = dotted.bytes().take_while(|&b| b == b'[').count();
    let shown = if dims == 0 { dotted } else { array_name(&dotted, dims) };
    // After the slash replacement, or the new slash would become a dot.
    shown.replace("+0x", "/0x")
}

/// `[[I` → `int[][]`; a descriptor that is not one stays as it is.
fn array_name(dotted: &str, dims: usize) -> String {
    let element = &dotted[dims..];
    let base = match element {
        "Z" => "boolean",
        "B" => "byte",
        "C" => "char",
        "S" => "short",
        "I" => "int",
        "J" => "long",
        "F" => "float",
        "D" => "double",
        _ => match element.strip_prefix('L').and_then(|e| e.strip_suffix(';')) {
            Some(class) => class,
            None => return dotted.to_owned(),
        },
    };
    format!("{base}{}", "[]".repeat(dims))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names() {
        for (hprof, shown) in [
            ("[Z", "boolean[]"),
            ("[J", "long[]"),
            ("[[D", "double[][]"),
            ("[Ljava/lang/String;", "java.lang.String[]"),
            ("java/util/HashMap$Node", "java.util.HashMap$Node"),
            ("Gen$$Lambda+0x0000007800000a00", "Gen$$Lambda/0x0000007800000a00"),
        ] {
            assert_eq!(display_name(hprof), shown, "{hprof}");
        }
    }

    #[test]
    fn dotted_names_and_hidden_class_arrays() {
        for (hprof, shown) in [
            ("java.lang.String", "java.lang.String"),
            ("[Ljava.lang.Object;", "java.lang.Object[]"),
            ("[[Lpkg.Gen$$Lambda+0x0000007800000a00;", "pkg.Gen$$Lambda/0x0000007800000a00[][]"),
            ("[Ljava.lang.String", "[Ljava.lang.String"),
            ("[Q", "[Q"),
            ("0x7f00", "0x7f00"),
            ("", ""),
        ] {
            assert_eq!(display_name(hprof), shown, "{hprof}");
        }
    }
}
