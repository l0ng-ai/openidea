//! The `artisanCommand` reference kind: an Artisan command
//! ([`ArtisanCommands`]) in `Artisan::call('…')` / `Artisan::queue('…')`
//! (and on the console kernel), a command's `$this->call('…')` /
//! `callSilent(…)` / `callSilently(…)`, `Schedule::command('…')` (and
//! `$schedule->command(…)`), and a test's `$this->artisan('…')`, as
//! Laravel's documentation on Artisan writes them.
//!
//! The string may hold arguments after the name
//! (`'posts:publish --dry-run'`): completion offers the command names on
//! the first word and the command's options (`--dry-run`, `--queue=`)
//! after it; goto opens the command's signature (its class, or its closure
//! in `routes/console.php`); hover shows its description and synopsis; find
//! usages works from a usage and from the name in a `$signature`.
//! `PhpUnknownArtisanCommand` reports a name no command has, only when
//! `vendor/` is installed, so that the packages' commands are known.
//!
//! The `artisanOption` kind ([`ArtisanOptionKind`]) is a key of the
//! parameters array given with the command (`Artisan::call('posts:publish',
//! ['--dry-run' => true])`): an option (`--dry-run`, or its shortcut `-D`)
//! or an argument (`post`) of the command the first argument names, by name
//! or by class. It completes them, goes to them in the signature, shows
//! their description and finds the keys naming the same one of the same
//! command.

use std::path::Path;
use std::sync::Arc;

use ide_core::Severity;

use super::{
    CalleePattern, Declared, PlacePattern, Position, RefContext, RefItem, ReferenceKind, RenameTarget, Undefined,
};
use crate::frameworks::laravel::artisan::{
    ArtisanArgument, ArtisanCommand, ArtisanCommands, ArtisanOption, CommandSource,
};
use crate::navigate::Target;
use crate::syntax::ParsedFile;

const ARTISAN: &[&str] = &[
    "Illuminate\\Support\\Facades\\Artisan",
    "Illuminate\\Contracts\\Console\\Kernel",
    "Illuminate\\Foundation\\Console\\Kernel",
];
const COMMANDS: &[&str] = &["Illuminate\\Console\\Command", "Illuminate\\Console\\Concerns\\CallsCommands"];
const SCHEDULES: &[&str] = &["Illuminate\\Support\\Facades\\Schedule", "Illuminate\\Console\\Scheduling\\Schedule"];
const TESTS: &[&str] =
    &["Illuminate\\Foundation\\Testing\\Concerns\\InteractsWithConsole", "Illuminate\\Foundation\\Testing\\TestCase"];

static PATTERNS: [PlacePattern; 4] = [
    PlacePattern::argument(CalleePattern::Method { classes: ARTISAN, names: &["call", "queue"] }, 0, "command"),
    PlacePattern::argument(
        CalleePattern::Method { classes: COMMANDS, names: &["call", "callSilent", "callSilently"] },
        0,
        "command",
    ),
    PlacePattern::argument(CalleePattern::Method { classes: SCHEDULES, names: &["command"] }, 0, "command"),
    PlacePattern::argument(CalleePattern::Method { classes: TESTS, names: &["artisan"] }, 0, "command"),
];

static OPTION_PATTERNS: [PlacePattern; 4] = [
    PlacePattern::argument(CalleePattern::Method { classes: ARTISAN, names: &["call", "queue"] }, 1, "parameters")
        .at(Position::ArrayKey),
    PlacePattern::argument(
        CalleePattern::Method { classes: COMMANDS, names: &["call", "callSilent", "callSilently"] },
        1,
        "arguments",
    )
    .at(Position::ArrayKey),
    PlacePattern::argument(CalleePattern::Method { classes: SCHEDULES, names: &["command"] }, 1, "parameters")
        .at(Position::ArrayKey),
    PlacePattern::argument(CalleePattern::Method { classes: TESTS, names: &["artisan"] }, 1, "parameters")
        .at(Position::ArrayKey),
];

fn commands(cx: &RefContext<'_>) -> Arc<ArtisanCommands> {
    cx.engine.laravel_artisan().unwrap_or_default()
}

/// The command name of a value (its first word) and the byte range of it.
fn name_of(value: &str) -> (&str, usize, usize) {
    let start = value.len() - value.trim_start().len();
    let end = value[start..].find(char::is_whitespace).map_or(value.len(), |len| start + len);
    (&value[start..end], start, end)
}

/// Where command `command` is declared.
pub(crate) fn command_target(command: &ArtisanCommand) -> Option<Target> {
    Some(Target { path: command.path.clone()?, range: command.range? })
}

/// `posts:publish`'s hover.
pub(crate) fn command_hover(command: &ArtisanCommand) -> String {
    let mut out = format!("**artisan** `{}`", command.name);
    if !command.description.is_empty() {
        out.push_str(&format!("\n\n{}", command.description));
    }
    out.push_str(&format!("\n\n`{}`", command.synopsis()));
    let mut lines = Vec::new();
    for argument in &command.arguments {
        let description =
            if argument.description.is_empty() { String::new() } else { format!(" — {}", argument.description) };
        lines.push(format!("`{}`{description}", argument.name));
    }
    for option in &command.options {
        let description =
            if option.description.is_empty() { String::new() } else { format!(" — {}", option.description) };
        lines.push(format!("`--{}`{description}", option.name));
    }
    if !lines.is_empty() {
        out.push_str(&format!("\n\n{}", lines.join("  \n")));
    }
    if let Some(class) = &command.class {
        out.push_str(&format!("\n\n`{class}`"));
    } else if command.source == CommandSource::Closure {
        out.push_str("\n\nClosure command");
    }
    out
}

/// See the module documentation.
pub struct ArtisanCommandKind;

impl ReferenceKind for ArtisanCommandKind {
    fn id(&self) -> &'static str {
        "artisanCommand"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let commands = commands(cx);
        let (name, _, name_end) = name_of(value);
        if at <= name_end {
            return commands
                .commands
                .iter()
                .map(|command| RefItem {
                    label: command.name.clone(),
                    insert: command.name.clone(),
                    detail: Some(command.description.clone()).filter(|d| !d.is_empty()),
                    from: 0,
                    to: name_end,
                })
                .collect();
        }
        // An option of the command, in the word at the caret.
        let Some(command) = commands.get(name) else { return Vec::new() };
        let from = value[..at].rfind(char::is_whitespace).map_or(0, |space| space + 1);
        let to = value[at..].find(char::is_whitespace).map_or(value.len(), |len| at + len);
        // Options given before the caret's word aren't offered again.
        let given: Vec<&str> =
            value[..from].split_whitespace().map(|word| word.split('=').next().unwrap_or(word)).collect();
        command
            .options
            .iter()
            .filter(|option| option.array || !given.contains(&format!("--{}", option.name).as_str()))
            .map(|option| {
                let flag = format!("--{}", option.name);
                RefItem {
                    label: flag.clone(),
                    insert: if option.accepts_value { format!("{flag}=") } else { flag },
                    detail: Some(option.description.clone()).filter(|d| !d.is_empty()),
                    from,
                    to,
                }
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let (name, _, _) = name_of(value);
        commands(cx).get(name).and_then(command_target).into_iter().collect()
    }

    fn usage_words(&self, value: &str) -> Vec<String> {
        crate::index::words(name_of(value).0)
    }

    fn usage_text<'v>(&self, value: &'v str) -> &'v str {
        name_of(value).0
    }

    fn canonical(&self, _cx: &RefContext<'_>, value: &str) -> String {
        name_of(value).0.to_owned()
    }

    fn refers_to(&self, value: &str, key: &str) -> bool {
        name_of(value).0 == key
    }

    fn declared_at(&self, cx: &RefContext<'_>, path: &Path, _parsed: &ParsedFile, offset: u32) -> Option<Declared> {
        let commands = commands(cx);
        commands.in_file(path).find_map(|command| {
            let (start, end) = command.bytes?;
            // A class without a name string has the class name there.
            if command.class_range.is_some_and(|range| Some(range) == command.range) {
                return None;
            }
            (start <= offset && offset <= end).then(|| Declared {
                value: command.name.clone(),
                start,
                end,
                at: (offset - start) as usize,
            })
        })
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        commands(cx).get(name_of(value).0).is_some()
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        commands(cx).get(name_of(value).0).map(command_hover)
    }

    fn undefined(&self, cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
        let commands = commands(cx);
        let (name, _, _) = name_of(value);
        // Without `vendor/` the packages' commands aren't known.
        if !commands.vendor || name.is_empty() || commands.get(name).is_some() {
            return None;
        }
        Some(Undefined {
            message: format!("Artisan command '{name}' is not defined"),
            severity: Severity::Warning,
            fixes: Vec::new(),
        })
    }
}

/// See the module documentation.
pub struct ArtisanOptionKind;

/// What a key of the parameters array names.
enum Parameter<'c> {
    Option(&'c ArtisanOption),
    Argument(&'c ArtisanArgument),
}

impl ArtisanOptionKind {
    /// The command the call names first, by name (its first word) or by
    /// class.
    fn command<'c>(cx: &RefContext<'_>, commands: &'c ArtisanCommands) -> Option<&'c ArtisanCommand> {
        let first = cx.site.as_ref()?.first_argument.as_deref()?;
        let (name, _, _) = name_of(first);
        commands.get(name).or_else(|| {
            let class = first.trim_start_matches('\\');
            commands
                .commands
                .iter()
                .find(|command| command.class.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(class)))
        })
    }

    /// The option (`--name`, `-S`) or argument (`name`) `key` names.
    fn parameter<'c>(command: &'c ArtisanCommand, key: &str) -> Option<Parameter<'c>> {
        let key = key.trim();
        if let Some(option) = key.strip_prefix("--") {
            return command.options.iter().find(|found| found.name == option).map(Parameter::Option);
        }
        if let Some(shortcut) = key.strip_prefix('-') {
            return command
                .options
                .iter()
                .find(|found| found.shortcut.as_deref().is_some_and(|s| s.split('|').any(|s| s == shortcut)))
                .map(Parameter::Option);
        }
        command.arguments.iter().find(|found| found.name == key).map(Parameter::Argument)
    }

    /// The command and key of a value: a key of a call (the command from
    /// the call), or a declaration's canonical `command --key`.
    fn command_and_key<'c, 'v>(
        cx: &RefContext<'_>,
        commands: &'c ArtisanCommands,
        value: &'v str,
    ) -> Option<(&'c ArtisanCommand, &'v str)> {
        if cx.site.is_some() {
            return Some((Self::command(cx, commands)?, value.trim()));
        }
        let (name, key) = value.split_once(' ')?;
        Some((commands.get(name)?, key.trim()))
    }

    /// Where the command class reads `parameter` (`$this->option('dry-run')`,
    /// `$this->hasArgument('post')`): byte ranges of the name.
    fn reads(text: &str, parameter: &Parameter<'_>) -> Vec<(u32, u32)> {
        let (name, methods): (&str, [&str; 2]) = match parameter {
            Parameter::Option(option) => (&option.name, ["option", "hasOption"]),
            Parameter::Argument(argument) => (&argument.name, ["argument", "hasArgument"]),
        };
        let mut out = Vec::new();
        for method in methods {
            for quote in ['\'', '"'] {
                let needle = format!("->{method}({quote}{name}{quote}");
                for (found, _) in text.match_indices(&needle) {
                    let at = (found + needle.len() - name.len() - 1) as u32;
                    out.push((at, at + name.len() as u32));
                }
            }
        }
        out
    }

    /// Where `parameter`'s name is written in `command`'s signature, looked
    /// for between the command's name and the end of its string.
    fn declaration(cx: &RefContext<'_>, command: &ArtisanCommand, parameter: &Parameter<'_>) -> Option<Target> {
        let path = command.path.clone()?;
        let (start, _) = command.bytes?;
        let text = cx.engine.text_of(&path)?;
        let rest = text.get(start as usize..)?;
        let signature = &rest[..rest.find(['\'', '"']).unwrap_or(rest.len())];
        let (name, found) = match parameter {
            Parameter::Option(option) => {
                let name = option.name.as_str();
                let found = name_after(signature, "--", name).or_else(|| name_after(signature, "|", name));
                (name, found)
            }
            Parameter::Argument(argument) => (argument.name.as_str(), name_after(signature, "{", &argument.name)),
        };
        let at = start + found? as u32;
        let lines = crate::syntax::LineIndex::new(&text);
        Some(Target { path, range: lines.range(at, at + name.len() as u32) })
    }
}

/// The byte `name` starts at in `signature` where it follows `before`
/// (spaces between them allowed) and nothing of a name follows it.
fn name_after(signature: &str, before: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = signature[from..].find(before) {
        let after = from + found + before.len();
        from = after;
        let rest = &signature[after..];
        let at = after + (rest.len() - rest.trim_start_matches(' ').len());
        let Some(tail) = signature[at..].strip_prefix(name) else { continue };
        if tail.chars().next().is_none_or(|c| !(c.is_alphanumeric() || c == '-' || c == '_')) {
            return Some(at);
        }
    }
    None
}

impl ReferenceKind for ArtisanOptionKind {
    fn id(&self) -> &'static str {
        "artisanOption"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &OPTION_PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        let commands = commands(cx);
        let Some(command) = Self::command(cx, &commands) else { return Vec::new() };
        let item = |label: String, description: &str| RefItem {
            insert: label.clone(),
            label,
            detail: Some(description.to_owned()).filter(|d| !d.is_empty()),
            from: 0,
            to: value.len(),
        };
        let options = command.options.iter().map(|option| item(format!("--{}", option.name), &option.description));
        let arguments = command.arguments.iter().map(|argument| item(argument.name.clone(), &argument.description));
        options.chain(arguments).collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let commands = commands(cx);
        let Some(command) = Self::command(cx, &commands) else { return Vec::new() };
        let Some(parameter) = Self::parameter(command, value) else { return Vec::new() };
        Self::declaration(cx, command, &parameter).or_else(|| command_target(command)).into_iter().collect()
    }

    /// `posts:publish --dry-run`: the command's name and the key.
    fn canonical(&self, cx: &RefContext<'_>, value: &str) -> String {
        let commands = commands(cx);
        let command = Self::command(cx, &commands).map_or("", |command| command.name.as_str());
        format!("{command} {}", value.trim())
    }

    fn usage_text<'v>(&self, value: &'v str) -> &'v str {
        value.rsplit(' ').next().unwrap_or(value)
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        let commands = commands(cx);
        // The keys of an unknown command can't be checked.
        Self::command(cx, &commands).is_none_or(|command| Self::parameter(command, value).is_some())
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let commands = commands(cx);
        let command = Self::command(cx, &commands)?;
        let (label, description) = match Self::parameter(command, value)? {
            Parameter::Option(option) => {
                let takes = if option.accepts_value { "=" } else { "" };
                (format!("--{}{takes}", option.name), &option.description)
            }
            Parameter::Argument(argument) => (argument.name.clone(), &argument.description),
        };
        let mut out = format!("**artisan** `{}` `{label}`", command.name);
        if !description.is_empty() {
            out.push_str(&format!("\n\n{description}"));
        }
        Some(out)
    }

    /// An option or argument named in a command's signature, after the
    /// command's name: its value is the canonical `command --key`.
    fn declared_at(&self, cx: &RefContext<'_>, path: &Path, parsed: &ParsedFile, offset: u32) -> Option<Declared> {
        let commands = commands(cx);
        let text = parsed.text();
        commands.in_file(path).find_map(|command| {
            let (start, end) = command.bytes?;
            if offset <= end || command.class_range.is_some_and(|range| Some(range) == command.range) {
                return None;
            }
            let rest = text.get(start as usize..)?;
            let signature = &rest[..rest.find(['\'', '"']).unwrap_or(rest.len())];
            let found = |at: Option<usize>, name: &str, key: String| {
                let at = start + at? as u32;
                (at <= offset && offset <= at + name.len() as u32).then(|| {
                    let value = format!("{} {key}", command.name);
                    let caret = value.len() - name.len() + (offset - at) as usize;
                    Declared { value, start: at, end: at + name.len() as u32, at: caret }
                })
            };
            command
                .options
                .iter()
                .find_map(|option| {
                    let name = option.name.as_str();
                    found(name_after(signature, "--", name), name, format!("--{name}"))
                })
                .or_else(|| {
                    command.arguments.iter().find_map(|argument| {
                        let name = argument.name.as_str();
                        found(name_after(signature, "{", name), name, name.to_owned())
                    })
                })
        })
    }

    /// The name of a known option or argument (not a shortcut): with its
    /// signature declaration and the command class's reads of it.
    fn rename_target(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Option<RenameTarget> {
        let commands = commands(cx);
        let (command, key) = Self::command_and_key(cx, &commands, value)?;
        if key.starts_with('-') && !key.starts_with("--") {
            return None;
        }
        let parameter = Self::parameter(command, key)?;
        let declaration = Self::declaration(cx, command, &parameter)?;
        let mut declarations = vec![(declaration.path.clone(), declaration.range)];
        if let Some(text) = cx.engine.text_of(&declaration.path) {
            let lines = crate::syntax::LineIndex::new(&text);
            declarations.extend(
                Self::reads(&text, &parameter)
                    .into_iter()
                    .map(|(from, to)| (declaration.path.clone(), lines.range(from, to))),
            );
        }
        // In a call the key is the site's value; the range is of the name in it.
        let dashes = key.len() - key.trim_start_matches('-').len();
        Some(RenameTarget { key: format!("{} {key}", command.name), range: (dashes, key.len()), declarations })
    }

    fn valid_name(&self, name: &str) -> bool {
        !name.is_empty()
            && !name.starts_with('-')
            && name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ':')
    }

    /// A key that is no option or argument of the command (only when
    /// `vendor/` is installed and the command is known), Symfony's global
    /// options aside.
    fn undefined(&self, cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
        let commands = commands(cx);
        if !commands.vendor {
            return None;
        }
        let command = Self::command(cx, &commands)?;
        let key = value.trim();
        let global = key.trim_start_matches('-');
        if key.is_empty() || GLOBAL_OPTIONS.contains(&global) || Self::parameter(command, key).is_some() {
            return None;
        }
        let what = if key.starts_with('-') { "an option" } else { "an argument" };
        Some(Undefined {
            message: format!("'{key}' is not {what} of Artisan command '{}'", command.name),
            severity: Severity::Warning,
            fixes: Vec::new(),
        })
    }
}

/// The options every Artisan command takes (Symfony's application), with
/// their shortcuts.
const GLOBAL_OPTIONS: &[&str] = &[
    "help",
    "h",
    "quiet",
    "q",
    "verbose",
    "v",
    "vv",
    "vvv",
    "version",
    "V",
    "ansi",
    "no-ansi",
    "no-interaction",
    "n",
    "env",
    "silent",
];
