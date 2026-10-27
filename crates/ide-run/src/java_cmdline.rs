//! IDEA's "Shorten command line" for `java` launches: a classpath too long for
//! the platform's command-line limit (Windows `CreateProcessW`: 32767 chars,
//! `os error 206`) moves into an `@argfile` (JDK 9+) or a pathing jar whose
//! manifest `Class-Path` lists the entries (any JDK, the only option on JDK 8).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// `CreateProcessW` takes at most 32767 chars including the NUL; leave slack for quoting.
pub const WINDOWS_LIMIT: usize = 32_000;
/// Linux caps one argument at 128 KiB (`MAX_ARG_STRLEN`); macOS the whole `ARG_MAX` (1 MiB, env included).
pub const UNIX_LIMIT: usize = 120_000;

/// How a long `java` command line is shortened (java-debug's `shortenCommandLine` values).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shortening {
    None,
    /// A temporary jar whose manifest `Class-Path` lists the classpath.
    JarManifest,
    /// A temporary `@argfile` holding `-cp` (and `--module-path`), JDK 9+.
    ArgFile,
}

impl Shortening {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::JarManifest => "jarmanifest",
            Self::ArgFile => "argfile",
        }
    }
}

pub fn command_line_limit(windows: bool) -> usize {
    if windows { WINDOWS_LIMIT } else { UNIX_LIMIT }
}

/// Length of the command line as the OS receives it (quotes and separators included).
pub fn command_line_length(program: &str, args: &[String]) -> usize {
    std::iter::once(program).chain(args.iter().map(String::as_str)).map(|a| a.len() + 3).sum()
}

/// Whether the longest single argument or the whole line exceeds the platform limit.
fn too_long(program: &str, args: &[String], windows: bool) -> bool {
    let limit = command_line_limit(windows);
    command_line_length(program, args) > limit || (!windows && args.iter().any(|a| a.len() > limit))
}

/// IDEA's automatic choice: nothing when the line fits; else an `@argfile` on JDK 9+
/// when every path is ASCII (the launcher reads argfiles in the platform charset),
/// else a pathing jar (works on every JDK; manifest URLs are percent-encoded UTF-8).
pub fn choose(too_long: bool, java_major: Option<u32>, classpath: &str) -> Shortening {
    if !too_long {
        Shortening::None
    } else if java_major.is_some_and(|v| v >= 9) && classpath.is_ascii() {
        Shortening::ArgFile
    } else {
        Shortening::JarManifest
    }
}

/// Room left for VM options and program arguments when only the paths are known.
const OTHER_ARGS_RESERVE: usize = 4_096;

/// The shortening a launcher that builds the command line itself (java-debug's
/// `shortenCommandLine`) should use for `java -cp <class_paths> [--module-path …] …`.
pub fn shortening_for(java: &Path, class_paths: &[String], module_paths: &[String], windows: bool) -> Shortening {
    let sep = if windows { ";" } else { ":" };
    let (cp, mp) = (class_paths.join(sep), module_paths.join(sep));
    let len = java.as_os_str().len() + cp.len() + mp.len() + 64 + OTHER_ARGS_RESERVE;
    let limit = command_line_limit(windows);
    choose(len > limit || cp.len() > limit || mp.len() > limit, java_feature_version(java), &format!("{cp}{mp}"))
}

/// `JAVA_VERSION="21.0.3"` (or `"1.8.0_372"`) from a JDK's `release` file.
pub fn parse_release(release: &str) -> Option<u32> {
    let line = release.lines().find_map(|l| l.trim().strip_prefix("JAVA_VERSION="))?;
    let mut parts = line.trim().trim_matches('"').split(['.', '_', '-', '+']);
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 { parts.next()?.parse().ok() } else { Some(first) }
}

/// Feature version of the JDK a `java` launcher belongs to (`<home>/bin/java`, or
/// JDK 8's `<home>/jre/bin/java`), following symlinks; `None` when unknown.
pub fn java_feature_version(java: &Path) -> Option<u32> {
    let java = std::fs::canonicalize(java).unwrap_or_else(|_| java.to_path_buf());
    java.ancestors()
        .skip(2)
        .take(2)
        .find_map(|home| std::fs::read_to_string(home.join("release")).ok())
        .and_then(|r| parse_release(&r))
}

/// `java`, `java.exe`, `javaw.exe`.
pub fn is_java_launcher(program: &Path) -> bool {
    let name = crate::wrap::program_name(&program.to_string_lossy()).to_ascii_lowercase();
    name == "java" || name == "javaw"
}

/// `java` options whose value is the next argument.
const WITH_VALUE: &[&str] = &[
    "-cp",
    "-classpath",
    "--class-path",
    "-p",
    "--module-path",
    "--upgrade-module-path",
    "--add-modules",
    "--add-opens",
    "--add-exports",
    "--add-reads",
    "--patch-module",
    "--limit-modules",
    "--enable-native-access",
];

/// Indices of the `-cp` and `--module-path` values among the VM options (before the main class).
fn path_options(args: &[String]) -> (Option<usize>, Option<usize>) {
    let (mut cp, mut mp) = (None, None);
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if matches!(a, "-jar" | "-m" | "--module") || !a.starts_with('-') {
            break;
        }
        if WITH_VALUE.contains(&a) {
            if i + 1 < args.len() {
                match a {
                    "-cp" | "-classpath" | "--class-path" => cp = Some(i + 1),
                    "-p" | "--module-path" => mp = Some(i + 1),
                    _ => {}
                }
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    (cp, mp)
}

/// A shortened command line and the temporary file it refers to (delete it once the process exits).
#[derive(Debug)]
pub struct Shortened {
    pub args: Vec<String>,
    pub file: PathBuf,
    pub how: Shortening,
}

/// Shortens `java [options] -cp <classpath> Main …` when it is too long for the platform:
/// `None` for other programs, lines that fit, or no classpath option.
pub fn shorten(
    program: &Path,
    args: &[String],
    cwd: &Path,
    windows: bool,
    temp_dir: &Path,
) -> std::io::Result<Option<Shortened>> {
    if !is_java_launcher(program) || !too_long(&program.to_string_lossy(), args, windows) {
        return Ok(None);
    }
    let (cp, mp) = path_options(args);
    let Some(cp) = cp else { return Ok(None) };
    let how = choose(true, java_feature_version(program), &args[cp]);
    std::fs::create_dir_all(temp_dir)?;
    let mut out = args.to_vec();
    let file = match how {
        Shortening::ArgFile => {
            let file = temp_file(temp_dir, "argfile");
            let mut moved = vec![cp - 1, cp];
            if let Some(mp) = mp {
                moved.extend([mp - 1, mp]);
            }
            moved.sort_unstable();
            let text = argfile_text(&moved.iter().map(|&i| args[i].clone()).collect::<Vec<_>>());
            std::fs::write(&file, text)?;
            for &i in moved.iter().rev() {
                out.remove(i);
            }
            out.insert(moved[0], format!("@{}", file.display()));
            file
        }
        _ => {
            let file = temp_file(temp_dir, "jar");
            let entries = classpath_entries(&args[cp], cwd, windows);
            write_pathing_jar(&entries, &file)?;
            out[cp] = file.to_string_lossy().into_owned();
            file
        }
    };
    Ok(Some(Shortened { args: out, file, how }))
}

/// Where launches put their pathing jars / argfiles.
pub fn default_temp_dir() -> PathBuf {
    std::env::temp_dir().join("openidea-classpath")
}

fn temp_file(dir: &Path, ext: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("classpath-{}-{nanos}-{n}.{ext}", std::process::id()))
}

/// Argument file lines: every argument quoted, `\` and `"` escaped (the launcher's argfile syntax).
pub fn argfile_text(args: &[String]) -> String {
    let mut out = String::new();
    for a in args {
        out.push('"');
        for c in a.chars() {
            if c == '\\' || c == '"' {
                out.push('\\');
            }
            out.push(c);
        }
        out.push_str("\"\n");
    }
    out
}

/// Classpath entries as absolute paths: relative ones against `cwd`, `dir/*` expanded to its jars.
pub fn classpath_entries(classpath: &str, cwd: &Path, windows: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in classpath.split(if windows { ';' } else { ':' }).filter(|e| !e.is_empty()) {
        let wildcard = e.strip_suffix("/*").or_else(|| e.strip_suffix("\\*"));
        let path = cwd.join(wildcard.unwrap_or(e));
        if wildcard.is_some() {
            let mut jars: Vec<PathBuf> = std::fs::read_dir(&path)
                .map(|rd| {
                    rd.flatten()
                        .map(|d| d.path())
                        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("jar")))
                        .collect()
                })
                .unwrap_or_default();
            jars.sort();
            out.extend(jars);
        } else {
            out.push(path);
        }
    }
    out
}

/// `file:` URL of a classpath entry: percent-encoded UTF-8, `/` separators, a trailing `/` on directories.
pub fn file_url(path: &str, dir: bool) -> String {
    let mut p = path.replace('\\', "/");
    if !p.starts_with('/') {
        p.insert(0, '/'); // `C:/x` → `/C:/x`
    } else if p.starts_with("//") {
        p.insert_str(0, "//"); // UNC `//server/share` → `file:////server/share`, as `File.toURI` does
    }
    if dir && !p.ends_with('/') {
        p.push('/');
    }
    let mut url = String::from("file:");
    for b in p.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/:".contains(&b) {
            url.push(b as char);
        } else {
            url.push_str(&format!("%{b:02X}"));
        }
    }
    url
}

/// `META-INF/MANIFEST.MF` listing `entries`, lines wrapped at 72 bytes (continuations start with a space).
pub fn manifest(entries: &[PathBuf]) -> String {
    let urls: Vec<String> = entries.iter().map(|e| file_url(&e.to_string_lossy(), e.is_dir())).collect();
    let mut out = String::from("Manifest-Version: 1.0\r\nCreated-By: OpenIDEA\r\n");
    out.push_str(&wrap_header(&format!("Class-Path: {}", urls.join(" "))));
    out.push_str("\r\n");
    out
}

/// One manifest header in lines of at most 72 bytes; `line` is ASCII (URLs are percent-encoded).
fn wrap_header(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    let mut width = 72;
    while !rest.is_empty() {
        let (head, tail) = rest.split_at(width.min(rest.len()));
        if width == 71 {
            out.push(' ');
        }
        out.push_str(head);
        out.push_str("\r\n");
        rest = tail;
        width = 71;
    }
    out
}

/// A jar holding only a manifest whose `Class-Path` is `entries` (IDEA's "JAR manifest").
pub fn write_pathing_jar(entries: &[PathBuf], out: &Path) -> std::io::Result<()> {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(out)?);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("META-INF/MANIFEST.MF", opts).map_err(std::io::Error::other)?;
    zip.write_all(manifest(entries).as_bytes())?;
    zip.finish().map_err(std::io::Error::other)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn chooses_like_idea() {
        assert_eq!(choose(false, Some(8), "a.jar"), Shortening::None);
        assert_eq!(choose(true, Some(8), "a.jar"), Shortening::JarManifest);
        assert_eq!(choose(true, None, "a.jar"), Shortening::JarManifest);
        assert_eq!(choose(true, Some(9), "a.jar"), Shortening::ArgFile);
        assert_eq!(choose(true, Some(21), "a.jar"), Shortening::ArgFile);
        assert_eq!(choose(true, Some(21), "C:\\用户\\a.jar"), Shortening::JarManifest);
    }

    #[test]
    fn debugger_launches_get_the_same_choice() {
        let dir = tempfile::tempdir().unwrap();
        let jdk = dir.path().join("jdk11");
        std::fs::create_dir_all(jdk.join("bin")).unwrap();
        std::fs::write(jdk.join("release"), "JAVA_VERSION=\"11.0.18\"").unwrap();
        let java = jdk.join("bin/java");
        let few = vec!["/r/a.jar".to_owned(); 10];
        let many = vec![r"C:\Users\dev\.m2\repository\org\x\lib\1.0\lib-1.0.jar".to_owned(); 600];
        assert_eq!(shortening_for(&java, &few, &[], true), Shortening::None);
        assert_eq!(shortening_for(&java, &many, &[], true), Shortening::ArgFile);
        assert_eq!(shortening_for(&java, &many, &[], false), Shortening::None);
        assert_eq!(shortening_for(Path::new("java"), &many, &[], true), Shortening::JarManifest);
    }

    #[test]
    fn release_versions() {
        assert_eq!(parse_release("JAVA_VERSION=\"1.8.0_372\"\n"), Some(8));
        assert_eq!(parse_release("IMPLEMENTOR=x\nJAVA_VERSION=\"21.0.3\""), Some(21));
        assert_eq!(parse_release("JAVA_VERSION=\"25\""), Some(25));
        assert_eq!(parse_release("nothing"), None);
    }

    #[test]
    fn feature_version_from_the_jdk_layout() {
        let dir = tempfile::tempdir().unwrap();
        let jdk8 = dir.path().join("jdk8");
        std::fs::create_dir_all(jdk8.join("jre/bin")).unwrap();
        std::fs::write(jdk8.join("release"), "JAVA_VERSION=\"1.8.0_372\"").unwrap();
        assert_eq!(java_feature_version(&jdk8.join("jre/bin/java")), Some(8));
        let jdk21 = dir.path().join("jdk21");
        std::fs::create_dir_all(jdk21.join("bin")).unwrap();
        std::fs::write(jdk21.join("release"), "JAVA_VERSION=\"21.0.3\"").unwrap();
        assert_eq!(java_feature_version(&jdk21.join("bin/java")), Some(21));
        assert_eq!(java_feature_version(Path::new("java")), None);
    }

    #[test]
    fn launchers() {
        for p in ["java", "/usr/bin/java", r"C:\jdk\bin\java.exe", r"C:\jdk\bin\javaw.exe", "JAVA.EXE"] {
            assert!(is_java_launcher(Path::new(p)), "{p}");
        }
        for p in ["javac", "kotlin", "/usr/bin/mvn", "java-agent"] {
            assert!(!is_java_launcher(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn finds_classpath_among_vm_options_only() {
        let a = strings(&["-Xmx1g", "--add-opens", "a/b=ALL", "-cp", "x.jar", "Main", "-cp", "y"]);
        assert_eq!(path_options(&a), (Some(4), None));
        let a = strings(&["-p", "mods", "-classpath", "x.jar", "Main"]);
        assert_eq!(path_options(&a), (Some(3), Some(1)));
        assert_eq!(path_options(&strings(&["-jar", "app.jar", "-cp", "x"])), (None, None));
        assert_eq!(path_options(&strings(&["Main", "-cp", "x"])), (None, None));
    }

    #[test]
    fn urls_are_encoded_and_directories_end_with_a_slash() {
        assert_eq!(file_url("/p/a b/x.jar", false), "file:/p/a%20b/x.jar");
        assert_eq!(file_url("/p/classes", true), "file:/p/classes/");
        assert_eq!(file_url("/p/classes/", true), "file:/p/classes/");
        assert_eq!(file_url(r"C:\Users\me\.m2\a+b#c.jar", false), "file:/C:/Users/me/.m2/a%2Bb%23c.jar");
        assert_eq!(file_url(r"\\srv\share\x.jar", false), "file:////srv/share/x.jar");
        assert_eq!(file_url("/p/用户/x.jar", false), "file:/p/%E7%94%A8%E6%88%B7/x.jar");
        assert_eq!(file_url("/p/100%/x.jar", false), "file:/p/100%25/x.jar");
    }

    #[test]
    fn manifest_lines_are_at_most_72_bytes() {
        let entries: Vec<PathBuf> = (0..300)
            .map(|i| PathBuf::from(format!("/home/u/.m2/repository/org/x/lib-{i}/1.0/lib {i}-1.0.jar")))
            .collect();
        let m = manifest(&entries);
        assert!(m.starts_with("Manifest-Version: 1.0\r\n"));
        assert!(m.ends_with("\r\n\r\n"));
        for line in m.split("\r\n") {
            assert!(line.len() <= 72, "{line:?}");
        }
        // Unwrapping restores the header exactly.
        let joined = m.replace("\r\n ", "");
        let joined = joined.lines().find_map(|l| l.strip_prefix("Class-Path: ")).unwrap();
        let urls: Vec<&str> = joined.split(' ').collect();
        assert_eq!(urls.len(), 300);
        assert_eq!(urls[7], "file:/home/u/.m2/repository/org/x/lib-7/1.0/lib%207-1.0.jar");
    }

    #[test]
    fn argfile_quotes_and_escapes() {
        assert_eq!(
            argfile_text(&strings(&["-cp", r#"C:\a b\x.jar;C:\q"y.jar"#])),
            "\"-cp\"\n\"C:\\\\a b\\\\x.jar;C:\\\\q\\\"y.jar\"\n"
        );
    }

    #[test]
    fn short_lines_and_other_programs_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let args = strings(&["-cp", "a.jar", "Main"]);
        assert!(shorten(Path::new("java"), &args, dir.path(), true, dir.path()).unwrap().is_none());
        let long = strings(&["-cp", &"x".repeat(40_000), "Main"]);
        assert!(shorten(Path::new("node"), &long, dir.path(), true, dir.path()).unwrap().is_none());
        // Fits the Unix limit; too long for Windows.
        assert!(shorten(Path::new("java"), &long, dir.path(), false, dir.path()).unwrap().is_none());
    }

    /// The reporter's case: JDK 8, ~270 jars, past 32767 chars on Windows.
    #[test]
    fn jdk8_gets_a_pathing_jar() {
        let dir = tempfile::tempdir().unwrap();
        let jdk = dir.path().join("jdk8");
        std::fs::create_dir_all(jdk.join("bin")).unwrap();
        std::fs::write(jdk.join("release"), "JAVA_VERSION=\"1.8.0_372\"").unwrap();
        let java = jdk.join("bin/java.exe");
        let cp: Vec<String> = (0..270)
            .map(|i| format!(r"C:\Users\developer01\.m2\repository\org\springframework\boot\spring-boot-starter-lib-{i}\2.7.18\spring-boot-starter-lib-{i}-2.7.18.jar"))
            .collect();
        let cp = format!(r"C:\work\demo\target\classes;{}", cp.join(";"));
        assert!(cp.len() > 32_767);
        let args =
            strings(&["-Dspring.profiles.active=dev", "-cp", &cp, "com.example.DemoApplication", "--port", "8080"]);
        let tmp = dir.path().join("tmp");
        let s = shorten(&java, &args, dir.path(), true, &tmp).unwrap().unwrap();
        assert_eq!(s.how, Shortening::JarManifest);
        assert_eq!(s.args[0], "-Dspring.profiles.active=dev");
        assert_eq!(s.args[1], "-cp");
        assert_eq!(s.args[2], s.file.to_string_lossy());
        assert_eq!(&s.args[3..], ["com.example.DemoApplication", "--port", "8080"]);
        assert!(command_line_length(&java.to_string_lossy(), &s.args) < 1_000);
        let mut jar = zip::ZipArchive::new(std::fs::File::open(&s.file).unwrap()).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut jar.by_name("META-INF/MANIFEST.MF").unwrap(), &mut text).unwrap();
        let text = text.replace("\r\n ", "");
        let urls: Vec<&str> = text.lines().find_map(|l| l.strip_prefix("Class-Path: ")).unwrap().split(' ').collect();
        assert_eq!(urls.len(), 271);
        assert!(urls.iter().all(|u| u.starts_with("file:/") && u.ends_with(".jar") || u.ends_with("classes")));
    }

    #[test]
    fn jdk9_plus_gets_an_argfile_with_the_module_path() {
        let dir = tempfile::tempdir().unwrap();
        let jdk = dir.path().join("jdk17");
        std::fs::create_dir_all(jdk.join("bin")).unwrap();
        std::fs::write(jdk.join("release"), "JAVA_VERSION=\"17.0.6\"").unwrap();
        let cp = vec!["/r/lib.jar"; 3_000].join(":");
        let args = strings(&["-Xmx1g", "--module-path", "/r/mods", "-cp", &cp, "a.Main", "x"]);
        let s = shorten(&jdk.join("bin/java"), &args, dir.path(), true, dir.path()).unwrap().unwrap();
        assert_eq!(s.how, Shortening::ArgFile);
        assert_eq!(s.args, ["-Xmx1g".to_owned(), format!("@{}", s.file.display()), "a.Main".into(), "x".into()]);
        let text = std::fs::read_to_string(&s.file).unwrap();
        assert_eq!(text, format!("\"--module-path\"\n\"/r/mods\"\n\"-cp\"\n\"{cp}\"\n"));
    }

    #[test]
    fn wildcards_and_relative_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("lib")).unwrap();
        for f in ["b.jar", "a.JAR", "notes.txt"] {
            std::fs::write(dir.path().join("lib").join(f), "").unwrap();
        }
        // An absolute entry stays as is; built from the temp dir so it is absolute on every platform.
        let abs = dir.path().join("abs").join("x.jar");
        let sep = if cfg!(windows) { ";" } else { ":" };
        let cp = ["classes", "lib/*", &abs.to_string_lossy()].join(sep);
        let e = classpath_entries(&cp, dir.path(), cfg!(windows));
        assert_eq!(e, [dir.path().join("classes"), dir.path().join("lib/a.JAR"), dir.path().join("lib/b.jar"), abs]);
    }

    /// A pathing jar really loads classes (and resources from directories) with this machine's JDKs.
    #[test]
    fn pathing_jar_runs_with_a_local_jdk() {
        let Some(home) = std::env::var_os("JAVA_HOME").map(PathBuf::from).or_else(|| {
            let java = crate::which::find_executable("java", &std::env::var_os("PATH").unwrap_or_default())?;
            std::fs::canonicalize(java).ok()?.parent()?.parent().map(Path::to_path_buf)
        }) else {
            return;
        };
        let bin = |t: &str| home.join("bin").join(if cfg!(windows) { format!("{t}.exe") } else { t.to_owned() });
        if !bin("javac").is_file() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src dir");
        let classes = dir.path().join("out classes");
        std::fs::create_dir_all(src.join("p")).unwrap();
        std::fs::create_dir_all(&classes).unwrap();
        std::fs::write(
            src.join("p/Main.java"),
            "package p; public class Main { public static void main(String[] a) { System.out.println(\"hello \" + a[0]); } }",
        )
        .unwrap();
        let ok = std::process::Command::new(bin("javac"))
            .args(["--release", "8", "-d"])
            .arg(&classes)
            .arg(src.join("p/Main.java"))
            .status()
            .is_ok_and(|s| s.success())
            || std::process::Command::new(bin("javac"))
                .arg("-d")
                .arg(&classes)
                .arg(src.join("p/Main.java"))
                .status()
                .is_ok_and(|s| s.success());
        assert!(ok, "javac failed");
        let mut entries: Vec<PathBuf> = (0..400).map(|i| dir.path().join(format!("missing {i}.jar"))).collect();
        entries.push(classes.clone());
        let jar = dir.path().join("cp.jar");
        write_pathing_jar(&entries, &jar).unwrap();
        let out =
            std::process::Command::new(bin("java")).arg("-cp").arg(&jar).args(["p.Main", "world"]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello world");
    }
}
