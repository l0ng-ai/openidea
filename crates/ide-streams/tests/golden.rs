//! Golden tests: each case's generated expressions run on a real JVM, and the recording it
//! produced goes through `run_trace`. `golden_fixtures` replays the committed recordings.

mod golden_cases;

use std::path::{Path, PathBuf};
use std::process::Command;

use golden_cases::{CASES, Case, K_CLASS, chain_and_plan, expect};
use ide_core::CancellationToken;
use ide_streams::{E1Value, Evaluator, ReadError, Recording, RecordingReader, TracePlan, TraceResult, run_trace};
use serde::Deserialize;

/// What the JVM handed back: the recorder list and E1's evaluate result.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenRun {
    recording: Recording,
    e1: E1Value,
}

/// E0 and E3 succeed; E1 answers what the JVM returned.
struct ReplayEval<'a> {
    plan: &'a TracePlan,
    e1: E1Value,
}

impl Evaluator for ReplayEval<'_> {
    async fn evaluate(&self, expression: &str) -> Result<E1Value, String> {
        if expression == self.plan.e1 {
            Ok(self.e1.clone())
        } else {
            Ok(E1Value { type_name: "Object".into(), text: "null".into() })
        }
    }
}

struct ReplayReader(Recording);

impl RecordingReader for ReplayReader {
    async fn read(&self, _key: &str, _limit: usize) -> Result<Recording, ReadError> {
        Ok(self.0.clone())
    }
}

async fn replay(plan: &TracePlan, run: GoldenRun) -> TraceResult {
    let eval = ReplayEval { plan, e1: run.e1 };
    run_trace(plan, &eval, &ReplayReader(run.recording), &CancellationToken::new()).await.expect("trace")
}

fn fixture(case: &Case) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden").join(format!("{}.json", case.name))
}

#[tokio::test]
async fn golden_fixtures() {
    for case in CASES {
        let (chain, plan) = chain_and_plan(case);
        let path = fixture(case);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let run: GoldenRun = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        expect(case, &chain, &replay(&plan, run).await);
    }
}

#[tokio::test]
#[ignore = "needs a real JDK >= 11: set OPENIDEA_TEST_JAVA to its bin/java"]
async fn golden_on_real_jdk() {
    let Some(java) = std::env::var_os("OPENIDEA_TEST_JAVA").map(PathBuf::from) else {
        eprintln!("OPENIDEA_TEST_JAVA is not set; skipping");
        return;
    };
    let update = std::env::var_os("OPENIDEA_UPDATE_GOLDEN").is_some_and(|v| v == "1");
    for case in CASES {
        let (chain, plan) = chain_and_plan(case);
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("Golden.java"), harness(case, &plan)).expect("write harness");
        let out = Command::new(&java).current_dir(dir.path()).args(["Golden.java", "run.json"]).output().expect("java");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{}: {}\n{stdout}", case.name, String::from_utf8_lossy(&out.stderr));
        assert!(stdout.lines().any(|l| l == "cleaned=true"), "{}: recorder left behind: {stdout}", case.name);

        let text = std::fs::read_to_string(dir.path().join("run.json")).expect("harness output");
        let run: GoldenRun = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}\n{text}", case.name));
        if update {
            std::fs::write(fixture(case), fixture_json(&run)).expect("write fixture");
        }
        let result = replay(&plan, run).await;
        println!("{}: {} records, {:?}", case.name, result.trace.records.len(), result.trace.outcome);
        expect(case, &chain, &result);
    }
}

/// One entry per line, so fixture diffs stay readable.
fn fixture_json(run: &GoldenRun) -> String {
    let entries: Vec<_> = run.recording.entries.iter().map(|e| format!("      {}", json(e))).collect();
    format!(
        "{{\n  \"recording\": {{\n    \"totalLen\": {},\n    \"entries\": [\n{}\n    ]\n  }},\n  \"e1\": {}\n}}\n",
        run.recording.total_len,
        entries.join(",\n"),
        json(&run.e1),
    )
}

fn json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("serialises")
}

/// `Golden.java`: runs E0, E1 as the body of `run()` (a throw becomes the result, as
/// `evaluate` reports it), writes the recorder list and E1's rendering to `args[0]` in
/// the serde shapes of `Recording` / `E1Value`, then runs E3 and prints `cleaned=true`
/// once the key is gone. Ids number objects by identity, like JDI's `uniqueID`.
fn harness(case: &Case, plan: &TracePlan) -> String {
    format!(
        r#"import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.*;

class Golden {{
{K_CLASS}
    static Object run() {{
        {locals}
        {e1}
    }}

    static final IdentityHashMap<Object, Integer> IDS = new IdentityHashMap<>();

    static int id(Object o) {{
        Integer id = IDS.get(o);
        if (id == null) {{
            id = IDS.size() + 1;
            IDS.put(o, id);
        }}
        return id;
    }}

    static String str(String s) {{
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {{
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }}
        return b.append('"').toString();
    }}

    static String boxKind(Object v) {{
        if (v instanceof Integer) return "int";
        if (v instanceof Long) return "long";
        if (v instanceof Short) return "short";
        if (v instanceof Byte) return "byte";
        if (v instanceof Character) return "char";
        if (v instanceof Boolean) return "boolean";
        if (v instanceof Float) return "float";
        if (v instanceof Double) return "double";
        return null;
    }}

    static String value(Object v) {{
        if (v == null) return "{{\"kind\":\"null\"}}";
        if (v instanceof String) {{
            return "{{\"kind\":\"str\",\"id\":" + id(v) + ",\"value\":" + str((String) v) + ",\"truncated\":false}}";
        }}
        String box = boxKind(v);
        if (box != null) {{
            return "{{\"kind\":\"boxed\",\"id\":" + id(v) + ",\"class\":\"" + box + "\",\"value\":" + str(String.valueOf(v)) + "}}";
        }}
        return "{{\"kind\":\"object\",\"id\":" + id(v) + ",\"class\":" + str(v.getClass().getName()) + "}}";
    }}

    static String e1(Object r) {{
        if (r == null) return "{{\"typeName\":\"null\",\"text\":\"null\"}}";
        String name = r.getClass().getSimpleName();
        return "{{\"typeName\":" + str(name) + ",\"text\":" + str(name + "@" + id(r) + " \"" + r + "\"") + "}}";
    }}

    public static void main(String[] args) throws Exception {{
        {e0};
        Object result;
        try {{
            result = run();
        }} catch (Throwable t) {{
            result = t;
        }}
        List<?> list = (List<?>) System.getProperties().get("{key}");
        StringBuilder entries = new StringBuilder();
        for (Object entry : list) {{
            if (entries.length() > 0) entries.append(',');
            entries.append(value(entry));
        }}
        String json = "{{\"recording\":{{\"entries\":[" + entries + "],\"totalLen\":" + list.size() + "}},\"e1\":" + e1(result) + "}}";
        Files.write(Paths.get(args[0]), json.getBytes(StandardCharsets.UTF_8));
        {e3};
        System.out.println();
        System.out.println("cleaned=" + !System.getProperties().containsKey("{key}"));
    }}
}}
"#,
        locals = case.locals,
        e1 = plan.e1,
        e0 = plan.e0,
        e3 = plan.e3,
        key = plan.key,
    )
}
