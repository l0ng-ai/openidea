//! Path aliases of a Vite, Rollup (`@rollup/plugin-alias`) or esbuild configuration, read
//! without running it.

use super::parse;
use std::path::{Component, Path, PathBuf};
use tree_sitter::{Language, Node};

/// `[alias, target]` pairs of the bundler configuration `text` in `dir`: every `alias`
/// property (Vite's `resolve.alias`, esbuild's `alias`) and, when the file uses
/// `@rollup/plugin-alias`, its `entries`. Both object (`{ '@': … }`) and array
/// (`[{ find, replacement }]`) forms. Targets are string literals, `path.resolve` /
/// `path.join` of `__dirname`, `process.cwd()` and literals, or
/// `fileURLToPath(new URL(…, import.meta.url))`, with `dir` as the configuration's
/// directory and working directory; relative literals stay relative. Aliases computed any
/// other way (variables, functions, regular expressions) are skipped.
pub fn bundler_aliases(text: &str, dir: &Path) -> Vec<(String, String)> {
    let language = Language::new(tree_sitter_typescript::LANGUAGE_TYPESCRIPT);
    let Some(tree) = parse(&language, text, None) else { return Vec::new() };
    let rollup = text.contains("@rollup/plugin-alias");
    let cx = Cx { src: text, dir };
    let mut out = Vec::new();
    let mut stack = vec![tree.root_node()];
    while let Some(node) = stack.pop() {
        if node.kind() == "pair"
            && let (Some(key), Some(value)) = (node.child_by_field_name("key"), node.child_by_field_name("value"))
            && match cx.name(key) {
                Some("alias") => true,
                Some("entries") => rollup,
                _ => false,
            }
        {
            cx.collect(value, &mut out);
        }
        stack.extend(node.named_children(&mut node.walk()));
    }
    out
}

struct Cx<'a> {
    src: &'a str,
    dir: &'a Path,
}

impl Cx<'_> {
    fn text(&self, n: Node) -> &str {
        n.utf8_text(self.src.as_bytes()).unwrap_or("")
    }

    /// A non-computed property key's name.
    fn name(&self, key: Node) -> Option<&str> {
        match key.kind() {
            "property_identifier" => Some(self.text(key)),
            "string" => self.literal(key),
            _ => None,
        }
    }

    /// The value of a string literal without escapes.
    fn literal(&self, s: Node) -> Option<&str> {
        match s.named_children(&mut s.walk()).collect::<Vec<_>>()[..] {
            [] => Some(""),
            [f] if f.kind() == "string_fragment" => Some(self.text(f)),
            _ => None,
        }
    }

    fn collect(&self, value: Node, out: &mut Vec<(String, String)>) {
        let value = unwrap(value);
        match value.kind() {
            "object" => {
                for pair in value.named_children(&mut value.walk()).filter(|n| n.kind() == "pair") {
                    let name = pair.child_by_field_name("key").and_then(|k| self.name(k));
                    let target = pair.child_by_field_name("value").and_then(|v| self.eval(v));
                    if let (Some(name), Some(target)) = (name, target) {
                        out.push((name.to_owned(), target));
                    }
                }
            }
            "array" => {
                for entry in value.named_children(&mut value.walk()).map(unwrap).filter(|n| n.kind() == "object") {
                    let field = |field: &str| {
                        entry.named_children(&mut entry.walk()).find_map(|p| {
                            let key = p.child_by_field_name("key").filter(|_| p.kind() == "pair")?;
                            (self.name(key) == Some(field)).then(|| p.child_by_field_name("value")).flatten()
                        })
                    };
                    let name = field("find").filter(|f| f.kind() == "string").and_then(|f| self.literal(f));
                    let target = field("replacement").and_then(|r| self.eval(r));
                    if let (Some(name), Some(target)) = (name, target) {
                        out.push((name.to_owned(), target));
                    }
                }
            }
            _ => {}
        }
    }

    /// The path `n` statically evaluates to.
    fn eval(&self, n: Node) -> Option<String> {
        let n = unwrap(n);
        match n.kind() {
            "string" => self.literal(n).map(str::to_owned),
            "template_string" => {
                let mut s = String::new();
                for part in n.named_children(&mut n.walk()) {
                    match part.kind() {
                        "string_fragment" => s.push_str(self.text(part)),
                        "template_substitution" => s.push_str(&self.eval(part.named_child(0)?)?),
                        _ => return None,
                    }
                }
                Some(s)
            }
            "identifier" if self.text(n) == "__dirname" => Some(self.dir_string()),
            "call_expression" => {
                let callee = n.child_by_field_name("function")?;
                let args = n.child_by_field_name("arguments")?;
                let args: Vec<Node> = args.named_children(&mut args.walk()).collect();
                match self.callee_name(callee)? {
                    "resolve" => {
                        let mut path = self.dir.to_path_buf();
                        for arg in args {
                            path.push(self.eval(arg)?);
                        }
                        Some(normalize(&path))
                    }
                    "join" => {
                        let parts: Option<Vec<String>> = args.into_iter().map(|a| self.eval(a)).collect();
                        Some(normalize(Path::new(&parts?.join("/"))))
                    }
                    "fileURLToPath" if args.len() == 1 => self.file_url(args[0]),
                    "cwd" if args.is_empty() && self.text(callee) == "process.cwd" => Some(self.dir_string()),
                    _ => None,
                }
            }
            // `new URL('./src', import.meta.url).pathname`
            "member_expression" if n.child_by_field_name("property").is_some_and(|p| self.text(p) == "pathname") => {
                self.file_url(n.child_by_field_name("object")?)
            }
            _ => None,
        }
    }

    /// `path.resolve` / `resolve` / `path.posix.join` / … → `resolve`.
    fn callee_name(&self, callee: Node) -> Option<&str> {
        match callee.kind() {
            "identifier" => Some(self.text(callee)),
            "member_expression" => callee.child_by_field_name("property").map(|p| self.text(p)),
            _ => None,
        }
    }

    /// `new URL('./src', import.meta.url)` → `<dir>/src`.
    fn file_url(&self, n: Node) -> Option<String> {
        let n = unwrap(n);
        if n.kind() != "new_expression" || n.child_by_field_name("constructor").map(|c| self.text(c)) != Some("URL") {
            return None;
        }
        let args = n.child_by_field_name("arguments")?;
        let [spec, base] = args.named_children(&mut args.walk()).collect::<Vec<_>>()[..] else { return None };
        if self.text(base) != "import.meta.url" {
            return None;
        }
        let spec = self.eval(spec)?;
        Some(normalize(&self.dir.join(spec.trim_start_matches('/'))))
    }

    fn dir_string(&self) -> String {
        self.dir.to_string_lossy().into_owned()
    }
}

/// Through `( … )`, `… as T`, `… satisfies T`.
fn unwrap(n: Node) -> Node {
    match n.kind() {
        "parenthesized_expression" | "as_expression" | "satisfies_expression" | "non_null_expression" => {
            n.named_child(0).map_or(n, unwrap)
        }
        _ => n,
    }
}

/// Lexical `.` / `..` removal, like Node's `path.resolve`.
fn normalize(path: &Path) -> String {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !out.has_root() {
                    out.push("..");
                }
            }
            c => out.push(c),
        }
    }
    out.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With `/` separators, so that the expectations hold on Windows too.
    fn aliases(text: &str) -> Vec<(String, String)> {
        bundler_aliases(text, Path::new("/p")).into_iter().map(|(a, t)| (a, t.replace('\\', "/"))).collect()
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect()
    }

    #[test]
    fn reads_vite_object_aliases() {
        let text = r#"import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      comps: path.resolve(__dirname, './src/components'),
      '~lib': fileURLToPath(new URL('./lib', import.meta.url)),
      up: path.join(__dirname, '..', 'shared'),
      root: '/src',
      tpl: `${__dirname}/tpl`,
      cwd: path.resolve(process.cwd(), 'app'),
      vue: 'vue/dist/vue.esm-bundler.js',
      dynamic: someDir,
      [computed]: path.resolve(__dirname, 'x'),
    },
  },
});"#;
        assert_eq!(
            aliases(text),
            pairs(&[
                ("@", "/p/src"),
                ("comps", "/p/src/components"),
                ("~lib", "/p/lib"),
                ("up", "/shared"),
                ("root", "/src"),
                ("tpl", "/p/tpl"),
                ("cwd", "/p/app"),
                ("vue", "vue/dist/vue.esm-bundler.js"),
            ])
        );
    }

    #[test]
    fn reads_array_aliases_and_rollup_entries() {
        let vite = r#"export default {
  resolve: { alias: [
    { find: '@', replacement: resolve(__dirname, 'src') },
    { find: /^~(.*)$/, replacement: '$1' },
    { find: 'x', replacement: compute() },
  ] },
};"#;
        assert_eq!(aliases(vite), pairs(&[("@", "/p/src")]));
        let rollup = r#"import alias from '@rollup/plugin-alias';
export default { plugins: [alias({ entries: [{ find: 'utils', replacement: './src/utils' }] })] };"#;
        assert_eq!(aliases(rollup), pairs(&[("utils", "./src/utils")]));
        // `entries` means nothing without the alias plugin.
        assert!(aliases("export default { entries: { a: './a' } };").is_empty());
        let esbuild = r#"require('esbuild').build({ entryPoints: ['a.js'], alias: { '@': './src' } });"#;
        assert_eq!(aliases(esbuild), pairs(&[("@", "./src")]));
    }

    #[test]
    fn dynamic_configurations_yield_nothing() {
        assert!(
            aliases("export default defineConfig(({ mode }) => ({ resolve: { alias: makeAliases(mode) } }));")
                .is_empty()
        );
        assert!(aliases("this is not { javascript").is_empty());
        assert!(aliases("").is_empty());
    }
}
