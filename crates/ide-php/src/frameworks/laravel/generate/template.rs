//! The file templates of the Laravel generators and their renderer.
//!
//! The default templates are the files of
//! `src/features/templates/files/laravel/`; the front end lists them on the
//! Code tab of Settings › Editor › File and Code Templates (as "Laravel
//! Model", …), where users edit them, and passes the edited bodies with each
//! generator request ([`TemplateSet`]).
//!
//! The syntax is the one of the other file templates, line-based:
//! - `$NAME$` (or `${NAME}`) is a variable: upper-case letters, digits and
//!   `_`. Unknown variables stay as written, and so does anything else after
//!   a `$` (`$table->id()` is PHP).
//! - `$$` writes a `$`, except right before a variable: `$$MODEL_VARIABLE$`
//!   is `$post`.
//! - A line holding a variable alone is replaced by its value, every line of
//!   it indented like the variable; it disappears when the value is empty.
//! - `#if ($NAME$)`, `#if (!$NAME$)`, `#else` and `#end` on lines of their
//!   own keep or drop the lines between them; a variable is true when it is
//!   set, not empty and not `false`.
//! - `$END$` (the caret of other file templates) is dropped.
//!
//! Blank lines the dropped lines leave behind are collapsed: never two in a
//! row, none right after an opening `{` or `[`, none right before a closing
//! one.

use std::collections::BTreeMap;

/// A default template: its name on the Code tab and its body.
#[derive(Clone, Copy, Debug)]
pub struct BuiltinTemplate {
    pub name: &'static str,
    pub body: &'static str,
}

macro_rules! builtin {
    ($name:literal, $file:literal) => {
        BuiltinTemplate {
            name: $name,
            body: include_str!(concat!("../../../../../../src/features/templates/files/laravel/", $file)),
        }
    };
}

pub const MODEL: &str = "Laravel Model";
pub const MIGRATION: &str = "Laravel Migration";
pub const FACTORY: &str = "Laravel Factory";
pub const SEEDER: &str = "Laravel Seeder";
pub const CONTROLLER: &str = "Laravel Controller";
pub const RESOURCE_CONTROLLER: &str = "Laravel Resource Controller";
pub const API_CONTROLLER: &str = "Laravel API Controller";
pub const FORM_REQUEST: &str = "Laravel Form Request";
pub const JSON_RESOURCE: &str = "Laravel JSON Resource";
pub const POLICY: &str = "Laravel Policy";
pub const PLAIN_POLICY: &str = "Laravel Plain Policy";
pub const MIDDLEWARE: &str = "Laravel Middleware";
pub const RESOURCE_COLLECTION: &str = "Laravel Resource Collection";
pub const UPDATE_MIGRATION: &str = "Laravel Update Migration";
pub const EVENT: &str = "Laravel Event";
pub const LISTENER: &str = "Laravel Listener";
pub const JOB: &str = "Laravel Job";
pub const MAIL: &str = "Laravel Mail";
pub const NOTIFICATION: &str = "Laravel Notification";
pub const OBSERVER: &str = "Laravel Observer";
pub const RULE: &str = "Laravel Rule";
pub const EXCEPTION: &str = "Laravel Exception";
pub const HTTP_EXCEPTION: &str = "Laravel HTTP Exception";
pub const PROVIDER: &str = "Laravel Service Provider";
pub const COMMAND: &str = "Laravel Console Command";
pub const COMPONENT: &str = "Laravel Component";
pub const COMPONENT_VIEW: &str = "Laravel Component View";
pub const VIEW: &str = "Laravel View";
pub const VIEW_COMPOSER: &str = "Laravel View Composer";
pub const CHANNEL: &str = "Laravel Channel";
pub const ENUM: &str = "Laravel Enum";
pub const TEST: &str = "Laravel Test";
pub const PEST_TEST: &str = "Laravel Pest Test";

/// The default templates, by name.
pub const BUILTIN_TEMPLATES: &[BuiltinTemplate] = &[
    builtin!("Laravel Model", "model.php.ft"),
    builtin!("Laravel Migration", "migration.php.ft"),
    builtin!("Laravel Factory", "factory.php.ft"),
    builtin!("Laravel Seeder", "seeder.php.ft"),
    builtin!("Laravel Controller", "controller.php.ft"),
    builtin!("Laravel Resource Controller", "controller.resource.php.ft"),
    builtin!("Laravel API Controller", "controller.api.php.ft"),
    builtin!("Laravel Form Request", "request.php.ft"),
    builtin!("Laravel JSON Resource", "resource.php.ft"),
    builtin!("Laravel Policy", "policy.php.ft"),
    builtin!("Laravel Plain Policy", "policy.plain.php.ft"),
    builtin!("Laravel Middleware", "middleware.php.ft"),
    builtin!("Laravel Resource Collection", "resource.collection.php.ft"),
    builtin!("Laravel Update Migration", "migration.update.php.ft"),
    builtin!("Laravel Event", "event.php.ft"),
    builtin!("Laravel Listener", "listener.php.ft"),
    builtin!("Laravel Job", "job.php.ft"),
    builtin!("Laravel Mail", "mail.php.ft"),
    builtin!("Laravel Notification", "notification.php.ft"),
    builtin!("Laravel Observer", "observer.php.ft"),
    builtin!("Laravel Rule", "rule.php.ft"),
    builtin!("Laravel Exception", "exception.php.ft"),
    builtin!("Laravel HTTP Exception", "exception.http.php.ft"),
    builtin!("Laravel Service Provider", "provider.php.ft"),
    builtin!("Laravel Console Command", "command.php.ft"),
    builtin!("Laravel Component", "component.php.ft"),
    builtin!("Laravel Component View", "component.blade.php.ft"),
    builtin!("Laravel View", "view.blade.php.ft"),
    builtin!("Laravel View Composer", "composer.php.ft"),
    builtin!("Laravel Channel", "channel.php.ft"),
    builtin!("Laravel Enum", "enum.php.ft"),
    builtin!("Laravel Test", "test.php.ft"),
    builtin!("Laravel Pest Test", "test.pest.php.ft"),
];

/// The templates a request uses: the user's edited bodies over the
/// defaults.
#[derive(Clone, Debug, Default)]
pub struct TemplateSet {
    edited: BTreeMap<String, String>,
}

impl TemplateSet {
    /// The defaults, with `edited` `(name, body)` pairs replacing them.
    pub fn new(edited: impl IntoIterator<Item = (String, String)>) -> Self {
        Self { edited: edited.into_iter().collect() }
    }

    /// The body of template `name`.
    pub fn body(&self, name: &str) -> Option<&str> {
        self.edited
            .get(name)
            .map(String::as_str)
            .or_else(|| BUILTIN_TEMPLATES.iter().find(|t| t.name == name).map(|t| t.body))
    }

    /// Renders template `name` with `vars`.
    pub fn render(&self, name: &str, vars: &Vars) -> Result<String, String> {
        let body = self.body(name).ok_or_else(|| format!("There is no template '{name}'"))?;
        render(body, vars).map_err(|e| format!("Template '{name}': {e}"))
    }
}

/// The values of a template's variables.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Vars(BTreeMap<String, String>);

impl Vars {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&mut self, name: &str, value: impl Into<String>) -> &mut Self {
        self.0.insert(name.to_owned(), value.into());
        self
    }

    /// A flag for `#if`: `true` or empty.
    pub fn flag(&mut self, name: &str, on: bool) -> &mut Self {
        self.set(name, if on { "true" } else { "" })
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }

    fn truthy(&self, name: &str) -> bool {
        self.get(name).is_some_and(|value| !value.trim().is_empty() && value.trim() != "false")
    }
}

/// `NAME` of a `$NAME$` or `${NAME}` at the start of `text`, and its length.
fn variable_at(text: &str) -> Option<(&str, usize)> {
    let rest = text.strip_prefix('$')?;
    let (braced, rest) = match rest.strip_prefix('{') {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let len = rest.bytes().take_while(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_').count();
    if len == 0 || !rest.as_bytes()[0].is_ascii_uppercase() && rest.as_bytes()[0] != b'_' {
        return None;
    }
    let close = if braced { '}' } else { '$' };
    rest[len..].starts_with(close).then(|| (&rest[..len], len + if braced { 3 } else { 2 }))
}

/// The variable of a line holding one alone (`    $FILLABLE$`), and the
/// line's indentation.
fn lone_variable(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    let trimmed = trimmed.trim_end();
    let (name, len) = variable_at(trimmed)?;
    (len == trimmed.len()).then_some((name, indent))
}

/// Substitutes the variables of one line.
fn substitute(line: &str, vars: &Vars) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find('$') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if let Some((name, len)) = variable_at(rest) {
            match (name, vars.get(name)) {
                ("END", _) => {}
                (_, Some(value)) => out.push_str(value),
                (_, None) => out.push_str(&rest[..len]),
            }
            rest = &rest[len..];
        } else if rest.starts_with("$$") && variable_at(&rest[1..]).is_none() {
            out.push('$');
            rest = &rest[2..];
        } else {
            out.push('$');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

/// The condition of an `#if (…)` line: the variable and whether it's negated.
fn condition(line: &str) -> Result<(&str, bool), String> {
    let inner = line
        .strip_prefix("#if")
        .map(str::trim)
        .and_then(|rest| rest.strip_prefix('('))
        .and_then(|rest| rest.strip_suffix(')'))
        .map(str::trim)
        .ok_or_else(|| format!("'{line}' is not an #if (…) line"))?;
    let (negated, inner) = match inner.strip_prefix('!') {
        Some(rest) => (true, rest.trim()),
        None => (false, inner),
    };
    match variable_at(inner) {
        Some((name, len)) if len == inner.len() => Ok((name, negated)),
        _ => Err(format!("'{line}' must test one variable, like #if ($NAME$)")),
    }
}

/// Renders `body` with `vars` (see the module docs). Fails for unbalanced
/// `#if`/`#else`/`#end` lines.
pub fn render(body: &str, vars: &Vars) -> Result<String, String> {
    let body = body.replace("\r\n", "\n").replace('\r', "\n");
    // Per open `#if`: whether its lines are kept, and whether an `#else` was seen.
    let mut stack: Vec<(bool, bool)> = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    for line in body.lines() {
        let directive = line.trim();
        let active = stack.iter().all(|(on, _)| *on);
        if directive.starts_with("#if") && directive[3..].trim_start().starts_with('(') {
            let (name, negated) = condition(directive)?;
            stack.push((vars.truthy(name) != negated, false));
            continue;
        }
        if directive == "#else" {
            let Some((on, seen_else)) = stack.last_mut() else { return Err("#else without #if".to_owned()) };
            if *seen_else {
                return Err("Two #else lines for one #if".to_owned());
            }
            *on = !*on;
            *seen_else = true;
            continue;
        }
        if directive == "#end" {
            stack.pop().ok_or("#end without #if")?;
            continue;
        }
        if !active {
            continue;
        }
        if let Some((name, indent)) = lone_variable(line)
            && (name == "END" || vars.get(name).is_some())
        {
            let value = vars.get(name).unwrap_or_default();
            for value_line in value.lines() {
                lines.push(if value_line.trim().is_empty() { String::new() } else { format!("{indent}{value_line}") });
            }
            continue;
        }
        lines.push(substitute(line, vars).trim_end().to_owned());
    }
    if !stack.is_empty() {
        return Err("#if without #end".to_owned());
    }
    Ok(tidy(&lines))
}

/// Collapses the blank lines of `lines` (see the module docs) and ends the
/// text with one line break.
fn tidy(lines: &[String]) -> String {
    let mut out: Vec<&str> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.is_empty() {
            let after_open =
                out.last().is_none_or(|last| last.is_empty() || last.ends_with('{') || last.ends_with('['));
            let next = lines[i + 1..].iter().find(|line| !line.is_empty());
            let before_close =
                next.is_none_or(|next| next.trim_start().starts_with('}') || next.trim_start().starts_with(']'));
            if after_open || before_close {
                continue;
            }
        }
        out.push(line);
    }
    let mut text = out.join("\n");
    text.push('\n');
    text
}

/// Leaves out the return types of the function declarations of `php`
/// (`public function rules(): array` → `public function rules()`), for code
/// generated with type hints off. Parameter types stay: Laravel injects by
/// them.
pub fn strip_return_types(php: &str) -> String {
    let mut out = String::with_capacity(php.len());
    let mut rest = php;
    while let Some(at) = rest.find("function") {
        let boundary_before = rest[..at].chars().next_back().is_none_or(|c| !c.is_alphanumeric() && c != '_');
        let after = &rest[at + "function".len()..];
        let boundary_after = after.chars().next().is_some_and(|c| c.is_whitespace() || c == '(');
        out.push_str(&rest[..at + "function".len()]);
        rest = after;
        if !boundary_before || !boundary_after {
            continue;
        }
        // The parameter list.
        let Some(open) = rest.find('(') else { continue };
        if rest[..open].contains(['{', ';', '=']) {
            continue;
        }
        let mut depth = 0usize;
        let mut close = None;
        for (i, c) in rest[open..].char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(open + i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close) = close else { continue };
        out.push_str(&rest[..=close]);
        rest = &rest[close + 1..];
        // `: Type` up to the body, the `;` of an abstract method or the line's end.
        let trimmed = rest.trim_start_matches([' ', '\t']);
        if let Some(typed) = trimmed.strip_prefix(':') {
            let end = typed.find(['{', ';', '\n', '=']).unwrap_or(typed.len());
            if !typed[end..].starts_with('=') {
                let tail = &typed[end..];
                if tail.starts_with('{') {
                    out.push(' ');
                }
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vars {
        let mut vars = Vars::new();
        for (name, value) in pairs {
            vars.set(name, *value);
        }
        vars
    }

    #[test]
    fn substitutes_variables_and_keeps_php() {
        let vars = vars(&[("CLASS", "Post"), ("MODEL_VARIABLE", "post"), ("TABLE", "posts")]);
        assert_eq!(
            render(
                "class $CLASS$ { function show(${CLASS} $$MODEL_VARIABLE$) { $table->id(); $UNKNOWN$ $$x; $END$} }",
                &vars
            )
            .unwrap(),
            "class Post { function show(Post $post) { $table->id(); $UNKNOWN$ $x; } }\n"
        );
        assert_eq!(
            render("Schema::create('$TABLE$', fn ($t) => 1);", &vars).unwrap(),
            "Schema::create('posts', fn ($t) => 1);\n"
        );
    }

    #[test]
    fn lone_variables_are_indented_or_dropped() {
        let vars = vars(&[("ITEMS", "'a',\n\n'b',"), ("EMPTY", "")]);
        assert_eq!(render("[\n    $ITEMS$\n    $EMPTY$\n]", &vars).unwrap(), "[\n    'a',\n\n    'b',\n]\n");
        assert_eq!(render("{\n    $EMPTY$\n\n    x;\n}", &vars).unwrap(), "{\n    x;\n}\n");
        assert_eq!(render("a\n\n$EMPTY$\n\nb\n", &vars).unwrap(), "a\n\nb\n");
    }

    #[test]
    fn conditions_keep_or_drop_lines() {
        let body = "#if ($ON$)\non\n#else\noff\n#end\n#if (!$OFF$)\nnot off\n#end\n#if ($MISSING$)\n  #if ($ON$)\nnested\n  #end\n#end";
        assert_eq!(render(body, &vars(&[("ON", "true"), ("OFF", "false")])).unwrap(), "on\nnot off\n");
        assert_eq!(render(body, &vars(&[("ON", ""), ("OFF", "yes")])).unwrap(), "off\n");
        assert!(render("#if ($ON$)\nx", &Vars::new()).unwrap_err().contains("#end"));
        assert!(render("#end", &Vars::new()).is_err());
        assert!(render("#if (on)\n#end", &Vars::new()).is_err());
        assert!(render("#if ($A$)\n#else\n#else\n#end", &Vars::new()).is_err());
    }

    #[test]
    fn edited_templates_replace_the_defaults() {
        let set = TemplateSet::new([(SEEDER.to_owned(), "seed $MODEL$".to_owned())]);
        assert_eq!(set.render(SEEDER, &vars(&[("MODEL", "Post")])).unwrap(), "seed Post\n");
        assert!(set.body(MODEL).unwrap().contains("extends Model"));
        assert!(set.render("Laravel Nothing", &Vars::new()).is_err());
        for template in BUILTIN_TEMPLATES {
            assert!(render(template.body, &Vars::new()).is_ok(), "{}", template.name);
        }
    }

    #[test]
    fn return_types_are_stripped() {
        let php = "class A\n{\n    public function rules(): array\n    {\n        return fn (): int => 1;\n    }\n\n    public function view(User $user, ?Post $post = null): Response|bool\n    {\n    }\n\n    abstract public function run(): void;\n\n    public function functionName(): static {}\n}\n";
        assert_eq!(
            strip_return_types(php),
            "class A\n{\n    public function rules()\n    {\n        return fn (): int => 1;\n    }\n\n    public function view(User $user, ?Post $post = null)\n    {\n    }\n\n    abstract public function run();\n\n    public function functionName() {}\n}\n"
        );
    }
}
