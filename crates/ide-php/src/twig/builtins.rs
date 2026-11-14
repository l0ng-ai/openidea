//! The tags, filters, functions and tests Twig 3 ships with, and those the
//! Symfony Twig bridge adds. Signatures and one-line descriptions are
//! written from the public Twig and Symfony documentation
//! (twig.symfony.com/doc/3.x, symfony.com/doc/current/reference/twig_reference.html).

/// One built-in: its name, its arguments as written in the docs (`None` for
/// tags and arguments-less tests), and what it does.
#[derive(Clone, Copy, Debug)]
pub struct Builtin {
    pub name: &'static str,
    pub signature: Option<&'static str>,
    pub doc: &'static str,
}

const fn b(name: &'static str, signature: Option<&'static str>, doc: &'static str) -> Builtin {
    Builtin { name, signature, doc }
}

/// Tags that open a statement (`{% name`), plus the branch tags.
pub static TAGS: &[Builtin] = &[
    b("apply", None, "Applies filters to the enclosed template data."),
    b("autoescape", None, "Escapes the enclosed block with the given strategy."),
    b("block", None, "Defines a block that child templates can override."),
    b("cache", None, "Caches the enclosed fragment (twig/cache-extra)."),
    b("deprecated", None, "Triggers a deprecation notice when the template is used."),
    b("do", None, "Evaluates an expression without printing it."),
    b("else", None, "The else branch of an if or for."),
    b("elseif", None, "Another condition of an if."),
    b("embed", None, "Includes a template and overrides some of its blocks."),
    b("extends", None, "Makes this template a child of another one."),
    b("flush", None, "Flushes the output buffer."),
    b("for", None, "Loops over a sequence or mapping."),
    b("from", None, "Imports macros from a template into the current namespace."),
    b("guard", None, "Compiles the enclosed code only when a function, filter or test exists."),
    b("if", None, "Outputs the enclosed block when the condition holds."),
    b("import", None, "Imports a template's macros under an alias."),
    b("include", None, "Includes a template and returns its rendered content."),
    b("macro", None, "Defines a reusable piece of template, called like a function."),
    b("sandbox", None, "Sandboxes an included template."),
    b("set", None, "Assigns a value to a variable."),
    b("types", None, "Declares the types of the template's variables."),
    b("use", None, "Imports the blocks of another template (horizontal reuse)."),
    b("verbatim", None, "Outputs the enclosed content without evaluating it."),
    b("with", None, "Creates an inner scope with its own variables."),
];

pub static FILTERS: &[Builtin] = &[
    b("abs", None, "The absolute value of a number."),
    b("batch", Some("(size, fill = null, preserve_keys = true)"), "Splits a sequence into chunks of `size` items."),
    b("capitalize", None, "Uppercases the first character and lowercases the rest."),
    b("column", Some("(name, index = null)"), "The values of one column of a sequence of rows."),
    b("convert_encoding", Some("(to, from)"), "Converts a string from one encoding to another."),
    b("date", Some("(format = null, timezone = null)"), "Formats a date."),
    b("date_modify", Some("(modifier)"), "Modifies a date with a relative format string."),
    b("default", Some("(default = '')"), "The value, or `default` when it is undefined or empty."),
    b("e", Some("(strategy = 'html', charset = null)"), "Alias of `escape`."),
    b("escape", Some("(strategy = 'html', charset = null)"), "Escapes a string for safe insertion in the output."),
    b("filter", Some("(arrow)"), "The items of a sequence or mapping the arrow function keeps."),
    b("find", Some("(arrow)"), "The first item the arrow function matches."),
    b("first", None, "The first item of a sequence, mapping or string."),
    b("format", Some("(...values)"), "Replaces placeholders in a string, like `sprintf`."),
    b("invoke", Some("(...arguments)"), "Calls an arrow function with the arguments."),
    b("join", Some("(glue = '', and = null)"), "Joins the items of a sequence into a string."),
    b("json_encode", Some("(options = 0)"), "The JSON representation of a value."),
    b("keys", None, "The keys of a sequence or mapping."),
    b("last", None, "The last item of a sequence, mapping or string."),
    b("length", None, "The number of items of a sequence or mapping, or the length of a string."),
    b("lower", None, "Lowercases a string."),
    b("map", Some("(arrow)"), "Applies an arrow function to every item of a sequence or mapping."),
    b("merge", Some("(values)"), "Merges a sequence or mapping with another one."),
    b("nl2br", None, "Inserts HTML line breaks before the newlines of a string."),
    b("number_format", Some("(decimals = 0, decimal_point = '.', thousand_sep = ',')"), "Formats a number."),
    b("raw", None, "Marks the value as safe: it isn't escaped."),
    b("reduce", Some("(arrow, initial = null)"), "Reduces a sequence or mapping to a single value."),
    b("replace", Some("(from)"), "Replaces placeholders in a string."),
    b("reverse", Some("(preserve_keys = false)"), "Reverses a sequence, mapping or string."),
    b("round", Some("(precision = 0, method = 'common')"), "Rounds a number."),
    b("shuffle", None, "Shuffles a sequence, mapping or string."),
    b("slice", Some("(start, length = null, preserve_keys = false)"), "A slice of a sequence, mapping or string."),
    b("sort", Some("(arrow = null)"), "Sorts a sequence or mapping."),
    b("spaceless", None, "Removes the whitespace between HTML tags."),
    b("split", Some("(delimiter, limit = null)"), "Splits a string into a sequence."),
    b("striptags", Some("(allowed_tags = null)"), "Strips SGML/XML tags."),
    b("title", None, "Titlecases a string."),
    b("trim", Some("(character_mask = null, side = 'both')"), "Strips whitespace or other characters from both ends."),
    b("upper", None, "Uppercases a string."),
    b("url_encode", None, "Percent-encodes a string, or a mapping as a query string."),
];

pub static FUNCTIONS: &[Builtin] = &[
    b("attribute", Some("(object, method, arguments = [])"), "Reads a dynamic attribute of a variable."),
    b("block", Some("(name, template = null)"), "The content of a block."),
    b("constant", Some("(name, object = null)"), "The value of a PHP constant or class constant."),
    b("cycle", Some("(values, position)"), "Cycles over a sequence of values."),
    b("date", Some("(date = null, timezone = null)"), "Converts an argument to a date."),
    b("dump", Some("(...values)"), "Dumps information about variables (debug mode)."),
    b("enum", Some("(enum)"), "The cases of a PHP enum, for accessing them."),
    b("enum_cases", Some("(enum)"), "The cases of a PHP enum."),
    b(
        "include",
        Some("(template, variables = [], with_context = true, ignore_missing = false, sandboxed = false)"),
        "The rendered content of a template.",
    ),
    b("max", Some("(...values)"), "The largest value of a sequence or of the arguments."),
    b("min", Some("(...values)"), "The smallest value of a sequence or of the arguments."),
    b("parent", Some("()"), "The content of the parent block, inside a block override."),
    b("random", Some("(values = null, max = null)"), "A random value."),
    b("range", Some("(low, high, step = 1)"), "A sequence of numbers or letters."),
    b("source", Some("(name, ignore_missing = false)"), "The source of a template, unrendered."),
    b("template_from_string", Some("(template, name = null)"), "Loads a template from a string."),
];

pub static TESTS: &[Builtin] = &[
    b("constant", Some("(name)"), "Whether a variable equals a constant's value."),
    b("defined", None, "Whether a variable is defined in the current context."),
    b("divisible by", Some("(number)"), "Whether a number is divisible by another."),
    b("empty", None, "Whether a variable is empty."),
    b("even", None, "Whether a number is even."),
    b("iterable", None, "Whether a variable is a sequence or a traversable object."),
    b("mapping", None, "Whether a variable is a mapping."),
    b("null", None, "Whether a value is null."),
    b("odd", None, "Whether a number is odd."),
    b("same as", Some("(value)"), "Whether a value is identical (`===`) to another."),
    b("sequence", None, "Whether a variable is a sequence."),
];

/// Variables every template sees.
pub static GLOBALS: &[Builtin] = &[
    b("_charset", None, "The current charset."),
    b("_context", None, "All the variables of the current context."),
    b("_self", None, "The current template, for calling its own macros."),
];

/// The `loop` variable of a `for` body.
pub static LOOP: Builtin = b(
    "loop",
    None,
    "The current loop: `index`, `index0`, `revindex`, `revindex0`, `first`, `last`, `length`, `parent`.",
);

/// What the Symfony Twig bridge adds (`symfony/twig-bridge`).
pub static SYMFONY_TAGS: &[Builtin] = &[
    b("form_theme", None, "Sets the form themes of a form view."),
    b("stopwatch", None, "Times the enclosed code in the profiler."),
    b("trans", None, "Translates the enclosed text."),
    b("trans_default_domain", None, "Sets the default translation domain of the template."),
];

pub static SYMFONY_FILTERS: &[Builtin] = &[
    b("humanize", None, "Makes a technical name human readable."),
    b("sanitize_html", Some("(sanitizer = null)"), "Sanitizes HTML with the HTML Sanitizer."),
    b("serialize", Some("(format = 'json', context = [])"), "Serializes a value with the Serializer."),
    b("trans", Some("(arguments = [], domain = null, locale = null)"), "Translates a message."),
    b("yaml_dump", Some("(inline = 0, dumpObjects = 0)"), "Dumps a value as YAML."),
    b("yaml_encode", Some("(inline = 0, dumpObjects = 0)"), "Encodes a value as YAML."),
];

pub static SYMFONY_FUNCTIONS: &[Builtin] = &[
    b("absolute_url", Some("(path)"), "The absolute URL of a path."),
    b("asset", Some("(path, packageName = null)"), "The public URL of an asset."),
    b("asset_version", Some("(path, packageName = null)"), "The version of an asset."),
    b("controller", Some("(controller, attributes = [], query = [])"), "A controller reference for `render`."),
    b("csrf_token", Some("(intention)"), "A CSRF token."),
    b("form", Some("(view, variables = [])"), "Renders a whole form."),
    b("form_end", Some("(view, variables = [])"), "Renders the end tag of a form."),
    b("form_errors", Some("(view)"), "Renders the errors of a form field."),
    b("form_label", Some("(view, label = null, variables = [])"), "Renders the label of a form field."),
    b("form_rest", Some("(view, variables = [])"), "Renders the fields not rendered yet."),
    b("form_row", Some("(view, variables = [])"), "Renders the label, errors and widget of a field."),
    b("form_start", Some("(view, variables = [])"), "Renders the start tag of a form."),
    b("form_widget", Some("(view, variables = [])"), "Renders the widget of a form field."),
    b("is_granted", Some("(role, object = null, field = null)"), "Whether the user has a role or permission."),
    b("logout_path", Some("(key = null)"), "The relative logout URL of a firewall."),
    b("logout_url", Some("(key = null)"), "The absolute logout URL of a firewall."),
    b("path", Some("(route_name, route_parameters = [], relative = false)"), "The relative URL of a route."),
    b("relative_path", Some("(path)"), "A path relative to the current request."),
    b("render", Some("(uri, options = [])"), "Renders a controller or URL."),
    b("url", Some("(route_name, route_parameters = [], schemeRelative = false)"), "The absolute URL of a route."),
];

pub static SYMFONY_GLOBALS: &[Builtin] =
    &[b("app", None, "The application: `user`, `request`, `session`, `flashes`, `environment`, `debug`, `token`.")];
