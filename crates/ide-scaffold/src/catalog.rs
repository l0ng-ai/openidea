//! The built-in generators: `generators/<id>.toml`, embedded at build time.

use crate::model::{ChoiceOption, Def, Field, FieldDef, FieldKind, FieldKindDef, GeneratorInfo, OptionDef, When};
use std::collections::BTreeMap;
use std::sync::OnceLock;

macro_rules! generators {
    ($($id:literal),* $(,)?) => {
        &[$(($id, include_str!(concat!("../../../generators/", $id, ".toml")))),*]
    };
}

pub(crate) const SOURCES: &[(&str, &str)] = generators![
    "empty",
    // JVM
    "java",
    "kotlin",
    "spring-boot",
    "quarkus",
    "micronaut",
    "ktor",
    "scala",
    // Python
    "python",
    "django",
    "fastapi",
    "flask",
    // JavaScript / TypeScript
    "node",
    "vite",
    "nextjs",
    "nuxt",
    "angular",
    "sveltekit",
    "astro",
    "nestjs",
    "express",
    // Systems
    "go",
    "rust",
    "cpp",
    "zig",
    // .NET
    "dotnet",
    // PHP
    "php",
    "laravel",
    "symfony",
    // Ruby
    "ruby",
    "rails",
    // Mobile / other
    "dart",
    "flutter",
    "swift",
    "elixir",
    "phoenix",
    "haskell",
    "html",
];

pub(crate) fn parse(id: &str, source: &str) -> Result<Def, String> {
    let def: Def = toml::from_str(source).map_err(|e| format!("generators/{id}.toml: {e}"))?;
    if def.id != id {
        return Err(format!("generators/{id}.toml: id is `{}`", def.id));
    }
    Ok(def)
}

pub(crate) fn defs() -> &'static [Def] {
    static DEFS: OnceLock<Vec<Def>> = OnceLock::new();
    DEFS.get_or_init(|| {
        SOURCES
            .iter()
            .filter_map(|(id, source)| {
                parse(id, source).inspect_err(|e| tracing::error!("skipping generator: {e}")).ok()
            })
            .collect()
    })
}

pub(crate) fn def(id: &str) -> Option<&'static Def> {
    defs().iter().find(|d| d.id == id)
}

pub(crate) fn when_map(when: &When) -> BTreeMap<String, Vec<String>> {
    when.iter().map(|(k, v)| (k.clone(), v.values())).collect()
}

pub(crate) fn field(def: &FieldDef) -> Field {
    let kind = match &def.kind {
        FieldKindDef::Text { pattern, placeholder } => {
            FieldKind::Text { pattern: pattern.clone(), placeholder: placeholder.clone() }
        }
        FieldKindDef::Choice { options, segmented } => FieldKind::Choice {
            options: options
                .iter()
                .map(|o| match o {
                    OptionDef::Value(v) => ChoiceOption { value: v.clone(), label: v.clone() },
                    OptionDef::Labeled { value, label } => ChoiceOption { value: value.clone(), label: label.clone() },
                })
                .collect(),
            segmented: *segmented,
        },
        FieldKindDef::Checkbox => FieldKind::Checkbox,
        FieldKindDef::Sdk { sdk } => FieldKind::Sdk { sdk: sdk.clone() },
    };
    Field {
        id: def.id.clone(),
        label: def.label.clone(),
        kind,
        default: def.default.clone(),
        visible: when_map(&def.visible),
        hint: def.hint.clone(),
    }
}

pub(crate) fn info(def: &Def) -> GeneratorInfo {
    GeneratorInfo {
        id: def.id.clone(),
        name: def.name.clone(),
        group: def.group.clone(),
        icon: def.icon.clone(),
        order: def.order,
        description: def.description.clone(),
        git: def.git,
        fields: def.fields.iter().map(field).collect(),
        dynamic: def.service.is_some(),
    }
}

/// Every generator, in list order: by group as first listed, then `order`.
pub fn catalog() -> Vec<GeneratorInfo> {
    let defs = defs();
    let group_rank = |g: &str| defs.iter().position(|d| d.group == g).unwrap_or(usize::MAX);
    let mut out: Vec<GeneratorInfo> = defs.iter().map(info).collect();
    out.sort_by(|a, b| group_rank(&a.group).cmp(&group_rank(&b.group)).then(a.order.cmp(&b.order)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ArgDef, StepDef};
    use crate::template::{FILTERS, filters, references};
    use std::collections::BTreeSet;
    use std::path::Path;

    const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

    fn all() -> Vec<Def> {
        let (defs, errors): (Vec<_>, Vec<_>) =
            SOURCES.iter().map(|(id, source)| parse(id, source)).partition(Result::is_ok);
        let errors: Vec<String> = errors.into_iter().map(Result::unwrap_err).collect();
        assert!(errors.is_empty(), "{}", errors.join("\n\n"));
        defs.into_iter().map(Result::unwrap).collect()
    }

    fn step_templates(step: &StepDef) -> Vec<&str> {
        let mut out = vec![step.program.as_str()];
        out.extend(step.package.as_deref());
        out.extend(step.creates.as_deref());
        for arg in &step.args {
            match arg {
                ArgDef::Plain(a) => out.push(a),
                ArgDef::When { args, .. } => out.extend(args.iter().map(String::as_str)),
            }
        }
        out.extend(step.env.values().map(String::as_str));
        out
    }

    fn templates(def: &Def) -> Vec<&str> {
        let mut out: Vec<&str> = def.fields.iter().map(|f| f.default.as_str()).collect();
        out.extend(def.requires.iter().map(|r| r.program.as_str()));
        for f in &def.files {
            out.push(&f.path);
            out.push(&f.content);
        }
        for step in def.steps.iter().chain(&def.after) {
            out.extend(step_templates(step));
        }
        fn table<'a>(t: &'a toml::Table, out: &mut Vec<&'a str>) {
            for v in t.values() {
                match v {
                    toml::Value::String(s) => out.push(s),
                    toml::Value::Table(t) => table(t, out),
                    _ => {}
                }
            }
        }
        if let Some(t) = &def.settings {
            table(t, &mut out);
        }
        out
    }

    fn whens(def: &Def) -> Vec<&When> {
        let mut out: Vec<&When> = def.fields.iter().map(|f| &f.visible).collect();
        out.extend(def.requires.iter().map(|r| &r.when));
        out.extend(def.files.iter().map(|f| &f.when));
        for step in def.steps.iter().chain(&def.after) {
            out.push(&step.when);
            for arg in &step.args {
                if let ArgDef::When { when, .. } = arg {
                    out.push(when);
                }
            }
        }
        out
    }

    #[test]
    fn every_definition_file_is_listed_and_parses() {
        let on_disk: BTreeSet<String> = std::fs::read_dir(Path::new(ROOT).join("generators"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().trim_end_matches(".toml").to_owned())
            .collect();
        let listed: BTreeSet<String> = SOURCES.iter().map(|(id, _)| id.to_string()).collect();
        assert_eq!(on_disk, listed);
        assert_eq!(all().len(), SOURCES.len());
    }

    #[test]
    fn templates_refer_to_known_fields_and_filters() {
        for def in all() {
            let mut known: BTreeSet<&str> = def.fields.iter().map(|f| f.id.as_str()).collect();
            known.insert("name");
            let mut ids = BTreeSet::new();
            for f in &def.fields {
                assert!(ids.insert(&f.id), "{}: field `{}` twice", def.id, f.id);
                assert_ne!(f.id, "name", "{}: `name` is the dialog's own field", def.id);
            }
            for t in templates(&def) {
                for r in references(t) {
                    // A service's fields come from its metadata.
                    assert!(
                        known.contains(r.as_str()) || def.service.is_some(),
                        "{}: unknown field `{r}` in {t:?}",
                        def.id
                    );
                }
                for f in filters(t) {
                    assert!(FILTERS.contains(&f.as_str()), "{}: unknown filter `{f}`", def.id);
                }
            }
            for when in whens(&def) {
                for field in when.keys() {
                    assert!(known.contains(field.as_str()), "{}: condition on unknown field `{field}`", def.id);
                }
            }
            for step in def.steps.iter().chain(&def.after) {
                assert!(
                    step.program.is_empty() != step.package.is_none(),
                    "{}: `{}` needs a program or a package",
                    def.id,
                    step.label
                );
                if step.package.is_some() {
                    assert!(known.contains("pm"), "{}: a package step needs the `pm` field", def.id);
                }
            }
        }
    }

    #[test]
    fn choice_defaults_are_options() {
        for def in all() {
            for f in &def.fields {
                if let FieldKindDef::Choice { options, .. } = &f.kind
                    && !f.default.contains("{{")
                {
                    let values: Vec<String> = options
                        .iter()
                        .map(|o| match o {
                            OptionDef::Value(v) => v.clone(),
                            OptionDef::Labeled { value, .. } => value.clone(),
                        })
                        .collect();
                    assert!(values.contains(&f.default), "{}: `{}` defaults to {:?}", def.id, f.id, f.default);
                }
            }
        }
    }

    #[test]
    fn icons_exist() {
        let icons = std::fs::read_to_string(Path::new(ROOT).join("src/ui/icons.tsx")).unwrap();
        for def in all() {
            assert!(
                icons.contains(&format!("\"{}\":", def.icon)) || icons.contains(&format!("\n  {}:", def.icon)),
                "{}: no icon `{}`",
                def.id,
                def.icon
            );
        }
    }

    /// Text the UI shows, which it translates through the source-text catalogs.
    fn texts(def: &Def) -> Vec<String> {
        let mut out = Vec::new();
        if !def.description.is_empty() {
            out.push(def.description.clone());
        }
        for f in &def.fields {
            out.push(f.label.clone());
            if !f.hint.is_empty() {
                out.push(f.hint.clone());
            }
            // Option labels are mostly product names, so they are not checked.
            if let FieldKindDef::Text { placeholder, .. } = &f.kind
                && !placeholder.is_empty()
            {
                out.push(placeholder.clone());
            }
        }
        out.extend(def.requires.iter().filter(|r| !r.hint.is_empty()).map(|r| r.hint.clone()));
        out.extend(def.steps.iter().chain(&def.after).map(|s| s.label.clone()));
        out
    }

    #[test]
    fn shown_text_is_in_the_text_catalogs() {
        // The Chinese catalog is complete; others show English text they lack.
        for locale in ["zh"] {
            let path = Path::new(ROOT).join(format!("src/platform/locales/text/{locale}.json"));
            let catalog: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            let mut missing = BTreeSet::new();
            for def in all() {
                for text in texts(&def) {
                    if !catalog.contains_key(&text) {
                        missing.insert(text);
                    }
                }
            }
            for text in crate::engine::SHOWN {
                if !catalog.contains_key(*text) {
                    missing.insert(text.to_string());
                }
            }
            assert!(missing.is_empty(), "{locale}.json lacks {missing:#?}");
        }
    }
}
