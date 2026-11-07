#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistogramRow {
    /// Java source form: `int[]`, `java.lang.String[][]`, `Heap$Live`.
    pub name: String,
    /// `java.base@17.0.21`; absent on JDK 8 and for classes without a named module.
    pub module: Option<String>,
    pub instances: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClassHistogram {
    pub rows: Vec<HistogramRow>,
    /// Lines that started like a row (`<num>:`) but could not be read.
    pub skipped_lines: u32,
}

pub fn parse_class_histogram(text: &str) -> ClassHistogram {
    let mut histogram = ClassHistogram::default();
    for line in text.lines() {
        let Some(num) = line.split_whitespace().next() else {
            continue;
        };
        let is_row = num.strip_suffix(':').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
        if !is_row {
            continue;
        }
        match parse_row(line) {
            Some(row) => {
                // G1 pads heap regions with filler objects; they are not user data.
                if !row.name.starts_with("jdk.internal.vm.Filler") {
                    histogram.rows.push(row);
                }
            }
            None => histogram.skipped_lines += 1,
        }
    }
    histogram
}

fn parse_row(line: &str) -> Option<HistogramRow> {
    let (_, rest) = line.split_once(':')?;
    let rest = rest.trim_start();
    let (instances, rest) = rest.split_once(char::is_whitespace)?;
    let (bytes, rest) = rest.trim_start().split_once(char::is_whitespace)?;
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    let (jvm_name, module) = match rest.rsplit_once(" (") {
        Some((name, module)) if module.ends_with(')') => {
            (name.trim_end(), Some(module[..module.len() - 1].to_string()))
        }
        _ => (rest, None),
    };
    Some(HistogramRow {
        name: display_class_name(jvm_name),
        module,
        instances: instances.parse().ok()?,
        bytes: bytes.parse().ok()?,
    })
}

/// Converts a JVM class name (`[Ljava.lang.String;`, `[[I`) to its Java source form.
pub fn display_class_name(jvm_name: &str) -> String {
    let dims = jvm_name.bytes().take_while(|&b| b == b'[').count();
    if dims == 0 {
        return jvm_name.to_string();
    }
    let element = &jvm_name[dims..];
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
            None => return jvm_name.to_string(),
        },
    };
    format!("{base}{}", "[]".repeat(dims))
}

#[cfg(test)]
mod tests {
    use super::*;

    const JDK17: &str = " num     #instances         #bytes  class name (module)\n-------------------------------------------------------\n   1:          1085        3955024  [I (java.base@17.0.21)\n   2:       1000000       16000000  Heap$Live\n   3:          1218         107296  [Ljava.lang.Object; (java.base@17.0.21)\n   4:             4        3565864  [Ljdk.internal.vm.FillerElement; (java.base@25.0.3)\n   5:             2             64  [[B (java.base@17.0.21)\n   6:             1             16  Heap$$Lambda/0x000000080000c218\nTotal         31639        5354360\n";
    const JDK8: &str = "\n num     #instances         #bytes  class name\n----------------------------------------------\n   1:           425        3572968  [I\n   2:        100000        1600000  Heap$Live\nTotal        100425        5172968\n";

    #[test]
    fn parses_jdk17_rows_with_modules() {
        let h = parse_class_histogram(JDK17);
        assert_eq!(
            h.rows[0],
            HistogramRow {
                name: "int[]".into(),
                module: Some("java.base@17.0.21".into()),
                instances: 1085,
                bytes: 3955024
            }
        );
        assert_eq!(
            h.rows[1],
            HistogramRow { name: "Heap$Live".into(), module: None, instances: 1_000_000, bytes: 16_000_000 }
        );
        assert_eq!(h.rows[2].name, "java.lang.Object[]");
        assert_eq!(h.rows.iter().find(|r| r.name == "byte[][]").unwrap().instances, 2);
        assert_eq!(h.rows.last().unwrap().name, "Heap$$Lambda/0x000000080000c218");
    }

    #[test]
    fn drops_g1_filler_rows() {
        assert!(parse_class_histogram(JDK17).rows.iter().all(|r| !r.name.contains("jdk.internal.vm.Filler")));
    }

    #[test]
    fn parses_jdk8_without_module_column() {
        let h = parse_class_histogram(JDK8);
        assert_eq!(h.rows.len(), 2);
        assert_eq!(
            h.rows[1],
            HistogramRow { name: "Heap$Live".into(), module: None, instances: 100000, bytes: 1600000 }
        );
        assert_eq!(h.skipped_lines, 0);
    }

    #[test]
    fn counts_garbled_lines_instead_of_failing() {
        let h = parse_class_histogram("   1:   12  abc  Foo\n   2:   3   48  Bar\n");
        assert_eq!(h.rows.len(), 1);
        assert_eq!(h.skipped_lines, 1);
    }

    #[test]
    fn display_names_for_arrays() {
        for (jvm, shown) in [
            ("[Z", "boolean[]"),
            ("[J", "long[]"),
            ("[[D", "double[][]"),
            ("[Ljava.lang.String;", "java.lang.String[]"),
            ("java.util.HashMap$Node", "java.util.HashMap$Node"),
        ] {
            assert_eq!(display_class_name(jvm), shown);
        }
    }
}
