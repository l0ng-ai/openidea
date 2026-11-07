# Stream Debugger S1 (crate `ide-streams`: tìm chuỗi, chuẩn hoá, sinh biểu thức, giải mã, resolver) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crate `ide-streams` nhận source Java và dòng đang dừng, trả các chuỗi stream trace được (hoặc lý do từ chối), sinh ba biểu thức E0/E1/E3 cho `evaluate` của java-debug, rồi giải mã bản ghi E2 thành các bước kèm liên kết cha–con đúng theo property test; chưa có UI, IPC hay adapter thật (S2).

**Architecture:** `ide-syntax` mở thêm một API mượn cây tree-sitter (`with_tree`). `ide-streams` dùng cây đó để tìm chuỗi quanh dòng dừng, phân loại gốc, và gom "facts" cho các quy tắc chuẩn hoá 10.3 (byte range trong chuỗi). Chuẩn hoá là hàm thuần trên `StreamChain` + `TypeHints` (S2 điền gợi ý kiểu từ jdtls hover cho phần cú pháp không biết). Bộ sinh chèn `peek` ghi `Integer.valueOf(k)` rồi phần tử vào một `ArrayList` trong `System.getProperties()`. Phía đọc E2 là trait `RecordingReader` (S2 cài bằng `JvmInspector` của M2), phía evaluate là trait `Evaluator`; `run_trace` điều phối E0→E1→E2→E3 và luôn chạy E3. Resolver là hàm thuần trên log đã giải mã.

**Tech Stack:** Rust 2024, `tree-sitter` 0.25.10 + `tree-sitter-java` 0.23.5 (qua `ide-syntax`/`ide-language`), serde + specta (kiểu sẽ qua IPC ở S2), `insta` cho snapshot biểu thức, `tokio` (dev) cho test điều phối, Java single-file source (`java Foo.java`) cho fixture và test JVM thật `#[ignore]`.

**Spec:** `docs/superpowers/specs/2026-11-07-jvm-debug-link-design.md` (mục 3.1, 10.1–10.4, 14 dòng `ide-streams`, 15, 17–18).

## Global Constraints

- Crate `ide-streams` chỉ phụ thuộc `ide-core`, `ide-syntax`, `tree-sitter` (workspace), `serde`, `specta`, `thiserror`; không IO, không tokio ở `[dependencies]`; không nói chuyện với jdtls hay DAP (đó là S2).
- Không chép mã OpenJDK (GPL), mã IntelliJ, hay probe trong `scratchpad/`: fixture Java viết mới, nhỏ gọn.
- Test cần JVM thật để `#[ignore]` và đọc `OPENIDEA_TEST_JAVA` (đường dẫn `java`); fixture Java viết theo cú pháp Java 11 để chạy được trên 11/17/21/25.
- Toạ độ: dòng 0-based, cột UTF-16 (`ide_core::Pos { line, col }`, `Range`).
- Khoá bộ ghi `oi.<nonce>`; nonce 16 ký tự hex thường. Ngân sách mặc định `100_000` **mục** của list (một bản ghi = 2 mục).
- Thông điệp bộ ghi: `oi-budget:<nonce>` khi vượt ngân sách, `oi-thread:<nonce>` khi khác luồng ghi (đề xuất A1). Dấu kết thúc E1: `Integer.valueOf(-1)` rồi kết quả, cả với phép kết thúc `void`.
- Biến sinh ra dùng tiền tố dành riêng `__oi`, `__c_`, và tên `__r`; chuỗi của người dùng có định danh như vậy thì từ chối.
- Mọi kiểu công khai sẽ qua IPC ở S2: `#[derive(Serialize, Deserialize, specta::Type)]`, `#[serde(rename_all = "camelCase")]`; enum có dữ liệu dùng `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]` như `DebugEvent` (`crates/ide-core/src/event.rs:204`).
- Commit: `feat(debugger): …`, stage từng đường dẫn, không trailer `Co-Authored-By`. Không chạy clippy khi đang lặp; chạy một lần ở Task 12.

## Grounding

Bốn câu hỏi rủi ro nhất, mỗi câu một probe vứt đi trong `scratchpad/s1-spike/` (ngoài repo). Probe evaluate dùng lại harness DAP của C2 (`s1-spike/eval/harness.py`, jdtls + java-debug 0.53.2), JVM debuggee 17.0.21, 21.0.4, 25.0.3.

**Q1. tree-sitter-java 0.23.5 có tìm và phân loại được chuỗi quanh một dòng cho các ca 10.2 không?** Có. Probe `s1-spike/ts` (crate độc lập, `tree-sitter =0.25.10`, `tree-sitter-java =0.23.5`), file `Sample.java` 20 ca có marker. Output (rút gọn):

```
parse 2638 bytes in 2447 us, has_error=false            (debug build; mỗi truy vấn 0,5–6 ms)
C_NEW_STREAM: root=NewStream("nums.stream()") ops=["filter","map","collect"] notes=["rule4 unqualified static LIMIT (Sample field)"]
C_NEW_STREAM: root=NotNew("identifier:Collectors") ops=["toList"]          ← dương tính giả: Collectors.toList() trong đối số
C_TYPED_LAMBDA: ... notes=["rule2 typed params (Integer x)", "rule3 generic capture list: var = new ArrayList<>(nums)"]
C_TYPED_LAMBDA: root=NotNew("") ops=["toList"]                           ← dương tính giả: toList() import static
C_VARIABLE_ROOT: root=NotNew("identifier:given") ops=["filter","count"]
C_INTSTREAM: root=NewStream("IntStream.range(0, 10)") ops=["map","sum"]
C_ITERATOR: root=NewStream("nums.stream()") ops=["map","iterator"]
C_PARALLEL: root=NewStream("nums.parallelStream()") ops=["sequential","map","parallel","toList"]
C_ARRAYS / C_CHARS / C_CONCAT / C_GENERATE: root=NewStream("Arrays.stream(arr)") / ("text.chars()") / ("Stream.concat(...)") / ("Stream.generate(Math::random)")
C_OBJ_ARRAY: notes=["rule7 array creation new Object[]{ x, big }"]
C_NESTED: ops=["flatMap","toList"] notes=["rule3 generic capture m: Map<String, List<Integer>>"]
C_NO_TERMINAL / C_OPTIONAL: NO CHAIN
C_LAMBDA_BODY (in_lambda=true): scope=lambda_expression -> NO CHAIN
C_ANON: frame=["anonymous"]   C_RECORD: frame=["record"]   C_GENERIC: frame=["generic <T extends Comparable<T>>"]   C_SECONDARY: frame=["secondary-top-level Secondary"]
```

Lần chạy đầu (lấy lambda trong cùng làm scope) bị bác: lambda biểu thức một dòng nằm trên dòng dừng nên mọi ca thành `NO CHAIN`. Sửa: biết frame là lambda hay method phải lấy từ tên frame DAP (`lambda$…`), không suy được từ dòng → `StopContext.in_lambda`.

**Q2. Cú pháp một mình có đủ cho quy tắc 10.3 (2, 3, 4, 7, 8) không, và hỏi jdtls tốn bao nhiêu?** Đủ cho 2, 4 (static khai báo trong cùng file), 8 (hình dạng frame, import đơn); 3 đủ khi kiểu khai báo tường minh; **không đủ cho `var`/diamond** (`var list = new ArrayList<>(nums)`); 7 chỉ cần ngoài thân lambda. Output evaluate (giống hệt trên 17/21/25):

```
filter(x -> list.contains(x))                                         ERR [java.util.ArrayList<java cannot be resolved to a type]
prelude "java.util.ArrayList __c_list = list; " + filter(x -> __c_list.contains(x))       OK Long "7"
prelude "java.util.Map __c_m = m; " + flatMap(x -> ((List<Integer>) __c_m.get("a")).stream()...)  OK Long "16"
map(x -> x * LIMIT)        (private static)  ERR NullPointerException: ... ModuleBinding.canAccess(...) because "mod" is null
map(x -> x * Main.LIMIT)                      OK
record ở file riêng: Stream.of(x, y)...       ERR Stream cannot be resolved.
record ở file riêng: java.util.stream.Stream.of(x, y)...   OK Integer "3"
record là top-level phụ (cùng file Main.java): ERR Functional expressions cannot be evaluated inside local and or anonymous classes
Object __r = new Object[]{ big, k }; return __r;                      ERR InvalidTypeException: Generated value (int) is not compatible ...
Object __r = new Object[]{ (Object) (big), (Object) (k) }; ...       ERR (cast không giúp)
nums.stream().map(x -> new Object[]{ x, big }).count()                OK  (trong lambda là bytecode thật)
textDocument/hover trên `list`: 18–22 ms lần đầu, 1–2 ms các lần sau → "ArrayList<Integer> list - demo.Main.run(List<Integer>, int)"
textDocument/hover trên `m`:    1–2 ms → "Map<String, List<Integer>> m - demo.Main.run(List<Integer>, int)"
```

**Q3. Thiết kế bộ ghi E0–E3 có chạy qua JDT evaluate như một biểu thức trên JDK 17/21/25 không?** Có: 20 lần E1 (cộng E0/E2/E3 mỗi ca), cùng kết quả trên ba JDK. Lần chạy đầu trên 17 hỏng vì probe dịch class ở mức 21 (debuggee thoát ngay); sửa probe bằng `java.configuration.runtimes` rồi chạy lại. Dạng đã chạy: E1 = `java.util.ArrayList __oi = (java.util.ArrayList) System.getProperties().get("oi.a1"); Thread __oiT = Thread.currentThread(); Object __r = <chuỗi với .peek(__oiX -> { if (__oi.size() >= 100000 || Thread.currentThread() != __oiT) throw new IllegalStateException("oi-budget"); __oi.add(Integer.valueOf(k)); __oi.add(__oiX); })>; __oi.add(Integer.valueOf(-1)); __oi.add(__r); return __r;`. Output (JDK 25; 17 và 21 giống, chỉ khác id):

```
E0 put("oi.a1", new java.util.ArrayList())                            OK null              6–23 ms
nums.stream() filter map collect                                      OK ArrayList size=3  139–174 ms (lần đầu), sau đó 33–66 ms
IntStream.range(0,5).map(i -> i * i).sum()                            OK Integer "30"      (peek ghi int vào add(Object): OK)
LongStream.rangeClosed(1,3).mapToDouble(...).sum()                    OK Double "3.0"
list.parallelStream().map(...).toList()        (không sửa)            OK IllegalStateException "java.lang.IllegalStateException: java.lang.IllegalStateException: oi-budget"
list.parallelStream().map(...).sequential().toList()                  OK size=7, log 30 mục
Stream.iterate(1, x -> x + 1).filter(x -> x < 0).findFirst() (B=1000) OK IllegalStateException "java.lang.IllegalStateException: oi-budget"; size() = 1000
nums.stream().map(x -> x).count()               (List.of, SIZED)      OK Long "7"; size() = 2   (chỉ dấu kết thúc: pipeline không chạy)
nums.stream().map(x -> 10 / (x - 3)).toList()                         OK ArithmeticException "java.lang.ArithmeticException: / by zero"; size() = 6
nums.stream().forEach(...); Object __r = null; return __r;            OK null; size() = 14
E3 remove("oi.a1") != null && !containsKey("oi.a1")                   OK true              5–15 ms
E0+E1 gộp một evaluate                                                OK                   33–39 ms
evaluate trả DAP type ngắn: 'IllegalStateException', 'ArithmeticException', 'Long' (không có tên đầy đủ)
```

Phụ: đọc E2 bằng DAP `variables` (không phải đường của spec) trả 1802 mục trong 179 ms một request, nhưng `String` mất danh tính (`'"bb"'`) và `Integer` không có giá trị (`'Integer@141'`) → E2 cần `JvmInspector` (M2), đúng như spec.

**Q4. Resolver có viết được thành hàm Rust thuần trên log `(step, object id)` và đạt oracle kiểu C1 không?** Có. Probe `s1-spike/resolver`: `TraceGen.java` (mới, chạy chuỗi ngẫu nhiên thật trên JDK, mỗi phần tử mang con trỏ cha làm đáp án), 20.000 chuỗi × 3 chế độ danh tính (`ref`: object người dùng; `boxed`: `Stream<Integer>` có cache −128..127; `prim`: IntStream, mỗi `peek` bọc lại), resolver Rust:

```
JDK 17 / 21 / 25 (thứ tự stage và đáp án trùng nhau giữa các JDK; chỉ id khác)
60000 chain-modes resolved in 199–214 ms
mode   op                links    valueForBoxes     identityOnly
prim   sorted            13177                0             3990
prim   sortedByKey       12290                0             3548
prim   sortedDesc        12200                0             3761
(mọi dòng khác, kể cả ref/boxed sorted, map, filter, filterStateful, flatMap, mapMulti, skip, limit, distinct, takeWhile, dropWhile, peek: 0 / 0)
TOTAL links=431004 wrong(valueForBoxes)=0 wrong(identityOnly)=11299
```

Kết luận: phép đồng bộ dùng "bản ghi bước trước gần nhất"; `sorted` khớp theo **giá trị** với kiểu bọc và theo **danh tính** với object khác, cộng thứ tự xuất hiện. Chỉ dùng danh tính thì sai 29% ở primitive stream (đề xuất A2).

### Quyết định: thông tin kiểu lấy từ đâu

Cú pháp trước, gợi ý sau. `find_chains` tự giải được mọi trường hợp đo ở Q1–Q2 trừ kiểu của biến bắt khai báo `var` (và diamond). Với những biến đó nó trả `TypeQuery { id, name, pos }`; S2 hỏi jdtls `textDocument/hover` tại `pos` (đo: 18–22 ms lần đầu, 1–2 ms sau) và chuyển chuỗi hover qua `parse_hover_declared_type`, rồi gọi `normalize` với `TypeHints`. Không có gợi ý: dùng erasure lấy từ `new X<>(…)` (kiểu thô vẫn chạy cho `add/contains`, Q2) hoặc từ chối `MissingTypeHint`. S1 không gọi jdtls; mọi test dùng gợi ý giả.

## Review Focus

1. **Chuỗi nhiều dòng, breakpoint ở dòng giữa** (`.filter(y -> y > 0)` ở dòng thứ 3, frame method): vẫn tìm ra cả chuỗi. Test ở Task 3 (`multi_line_chain_found_from_a_middle_line`).
2. **Lời gọi trùng tên phép kết thúc mà không phải chuỗi** (`Collectors.toList()` trong đối số, `toList()` import static, `Optional.map().filter().orElse()`): không báo, và chuỗi thật chỉ báo một lần (Q1 đã thấy hai dương tính giả). Test ở Task 3 (`collector_calls_are_not_chains`).
3. **Lỗi cú pháp trong chuỗi** (người dùng đang gõ): chuỗi đó bị từ chối `SyntaxError`, chuỗi khác trong file vẫn tìm được, không panic. Test ở Task 3 (`syntax_error_rejects_only_the_broken_chain`).
4. **Định danh của người dùng trùng tên sinh ra** (`__oiX`, `__r`, `__c_list`): từ chối `ReservedIdentifier`, không sinh mã sai. Test ở Task 4 (`reserved_identifiers_are_rejected`).
5. **Bản ghi bị cắt hoặc lẻ** (reader có giới hạn thấp hơn, list kết thúc giữa cặp): giữ các cặp đủ, banner `Truncated`, hoặc `Malformed` có vị trí; không panic. Test ở Task 8 (`truncated_recording_keeps_whole_pairs`, `odd_recording_is_malformed`).

## Cấu trúc file

```
crates/ide-syntax/src/tree.rs                 SyntaxTree + StructureService::with_tree (mượn cây cho crate phân tích)
crates/ide-streams/
  Cargo.toml
  src/lib.rs                                  re-export
  src/model.rs                                TraceValue, BoxKind, Record, StepKind, Link, DistinctDrop
  src/catalog.rs                              bảng tên: nguồn stream, phép trung gian, phép kết thúc
  src/chain.rs                                find_chains, StreamChain, ChainSearch, Rejection, ChainWarning
  src/facts.rs                                gom facts chuẩn hoá khi còn cây (TextEdit, Capture, TypeQuery)
  src/normalize.rs                            normalize, TypeHints, Adjustment, parse_hover_declared_type
  src/qualify.rs                              tên đầy đủ cho frame record (import, java.lang, bảng gói wildcard)
  src/generate.rs                             TracePlan, build_plan, fresh_nonce
  src/resolve.rs                              resolve, sorted_pass_through, distinct_drops
  src/decode.rs                               decode, Outcome, Banner, classify_eval_error
  src/trace.rs                                Evaluator, RecordingReader, run_trace
  tests/fixtures/Chains.java                  fixture tìm chuỗi (marker // C_…)
  tests/fixtures/java/TraceOracle.java        sinh log + đáp án (Java 11)
  tests/fixtures/resolver/oracle-jdk21-seed1.jsonl
  tests/fixtures/golden/<case>.json           bản ghi thật từ JVM cho test vàng
  tests/chains.rs  tests/normalize.rs  tests/resolver_oracle.rs  tests/golden.rs
```

---

### Task 0: Plan vào nhánh, issue

**Files:** `docs/superpowers/plans/2026-11-07-debugger-streams-s1.md`

- [ ] **Step 1:** Không tạo issue hay PR ở đây: chủ repo chọn làm mọi mốc trên `feat/debugger-jvm-memory` và mở một PR ở cuối.
- [ ] **Step 2: Commit plan**: `git add docs/superpowers/plans/2026-11-07-debugger-streams-s1.md && git commit -m "feat(debugger): add the stream debugger S1 plan"`

---

### Task 1: `ide-syntax` cho mượn cây tree-sitter

**Files:**

- Create: `crates/ide-syntax/src/tree.rs`
- Modify: `crates/ide-syntax/src/lib.rs` (`mod tree; pub use tree::SyntaxTree;`), `crates/ide-syntax/src/tests/mod.rs` (thêm `mod tree;`)
- Test: `crates/ide-syntax/src/tests/tree.rs`

**Interfaces:**

- Produces:
  - `pub struct SyntaxTree<'a> { pub grammar: &'static str, pub tree: &'a tree_sitter::Tree, pub text: &'a str, lines: Lines<'a> }`
  - `impl SyntaxTree<'_> { pub fn range(&self, node: &tree_sitter::Node) -> Range; pub fn byte(&self, pos: Pos) -> usize; pub fn pos(&self, byte: usize) -> Pos }`
  - `impl StructureService { pub fn with_tree<R>(&self, snap: &Snapshot, cancel: &CancellationToken, f: impl FnOnce(&SyntaxTree<'_>) -> R) -> StructureResult<R> }` — đi qua `run` hiện có (cache, huỷ, `TooLarge`). Doc comment một dòng: cho crate phân tích (`ide-streams`) duyệt node; tọa độ ra luôn qua `range`/`pos` (UTF-16).

- [ ] **Step 1: Viết test thất bại** (`tests/tree.rs`):

```rust
#[test]
fn with_tree_reports_utf16_ranges() {
    let text = "class A { String s = \"é😀\"; int x = s.length(); }";
    let (range, byte) = service().with_tree(&Snapshot::text(&lang("java"), text), &none(), |t| {
        let mut cursor = t.tree.walk();
        let call = find_kind(t.tree.root_node(), "method_invocation", &mut cursor).unwrap();
        (t.range(&call), t.byte(Pos { line: 0, col: 36 }))
    }).unwrap();
    assert_eq!(range, Range { start: Pos { line: 0, col: 36 }, end: Pos { line: 0, col: 46 } });
    assert_eq!(byte, 39);
}
#[test]
fn with_tree_needs_a_grammar() {
    assert_eq!(service().with_tree(&Snapshot::text(&lang("plaintext"), "x"), &none(), |_| ()).unwrap_err(), StructureError::Unsupported);
}
```

(`find_kind` là helper đệ quy nhỏ trong file test.)

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-syntax tree` → FAIL (chưa có `with_tree`).
- [ ] **Step 3: Cài đặt** `SyntaxTree` (bọc `Lines` hiện có) và `with_tree`.
- [ ] **Step 4: Chạy lại**: `cargo test -p ide-syntax` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-syntax/src/tree.rs crates/ide-syntax/src/lib.rs crates/ide-syntax/src/tests/mod.rs crates/ide-syntax/src/tests/tree.rs && git commit -m "feat(syntax): lend tree-sitter trees to analysis crates"`

---

### Task 2: Crate `ide-streams`, mô hình và bảng phép toán

**Files:**

- Create: `crates/ide-streams/Cargo.toml`, `src/lib.rs`, `src/model.rs`, `src/catalog.rs`
- Modify: `Cargo.toml` (`[workspace.dependencies]`: `ide-streams = { path = "crates/ide-streams" }`)

Cargo: `description = "Java Stream Debugger engine: finds stream chains, builds peek-recording expressions for evaluate, decodes and links the recorded elements"`; deps `ide-core`, `ide-syntax`, `tree-sitter`, `serde`, `specta`, `thiserror` (đều `.workspace = true`); dev-deps `ide-language`, `insta`, `serde_json`, `tokio` (workspace).

**Interfaces:**

- Produces (`model.rs`):

```rust
pub enum BoxKind { Boolean, Byte, Char, Short, Int, Long, Float, Double }        // serde lowercase: "int"
pub enum TraceValue {                                                           // tag "kind"
    Null,
    Object { id: u64, class: String },                                          // id = JDI uniqueID; class = tên nhị phân
    Boxed { id: u64, class: BoxKind, value: String },                           // value = giá trị primitive dạng văn bản
    Str { id: u64, value: String, truncated: bool },
}
pub struct Record { pub step: u16, pub value: TraceValue }                     // thời gian = chỉ số trong Vec
pub enum StepKind { Sync, Reorder, Unlinked }
pub struct Link { pub parent: Option<u32>, pub ambiguous: bool }
pub struct DistinctDrop { pub dropped: u32, pub same_as: Option<u32> }
```

- Produces (`catalog.rs`):
  - `pub enum OpRole { Step(StepKind), Modifier, Terminal { void: bool }, LazyTerminal }` (công khai vì `ChainOp` ở Task 3 chứa nó); `pub(crate) fn op_role(name: &str) -> Option<OpRole>`
  - `pub(crate) enum SourceCheck { Fresh, Stateful, Rereads }`; `pub(crate) fn classify_source(receiver: Option<&str>, method: &str, receiver_is_string_literal: bool) -> Option<SourceCheck>`

Bảng (chép đúng):

- Sync: `filter map mapToInt mapToLong mapToDouble mapToObj flatMap flatMapToInt flatMapToLong flatMapToDouble flatMapToObj mapMulti mapMultiToInt mapMultiToLong mapMultiToDouble mapMultiToObj boxed asLongStream asDoubleStream peek distinct skip limit takeWhile dropWhile`; Reorder: `sorted`; Unlinked: `gather`; Modifier: `parallel sequential unordered onClose`.
- Terminal: `collect toList reduce count sum average min max summaryStatistics anyMatch allMatch noneMatch findFirst findAny toArray`, `void`: `forEach forEachOrdered`; LazyTerminal: `iterator spliterator`.
- Nguồn tĩnh (receiver bằng tên lớp hoặc kết thúc bằng `.<Lớp>`): `Stream: of ofNullable iterate concat empty` → Fresh, `Stream.generate` → Stateful; `IntStream`/`LongStream`: `range rangeClosed of iterate concat empty` Fresh, `generate` Stateful; `DoubleStream: of iterate concat empty` Fresh, `generate` Stateful; `Arrays.stream`, `StreamSupport: stream intStream longStream doubleStream` Fresh; `Files: lines list walk find` Rereads.
- Nguồn instance (có receiver): `stream parallelStream chars codePoints splitAsStream` Fresh; `lines` Rereads, trừ khi receiver là string literal/text block → Fresh; `tokens` Rereads; `ints longs doubles` Stateful.

- [ ] **Step 1: Viết test thất bại** (`catalog.rs`, `model.rs`):

```rust
#[test] fn op_roles() {
    assert_eq!(op_role("filter"), Some(OpRole::Step(StepKind::Sync)));
    assert_eq!(op_role("sorted"), Some(OpRole::Step(StepKind::Reorder)));
    assert_eq!(op_role("gather"), Some(OpRole::Step(StepKind::Unlinked)));
    assert_eq!(op_role("parallel"), Some(OpRole::Modifier));
    assert_eq!(op_role("forEach"), Some(OpRole::Terminal { void: true }));
    assert_eq!(op_role("collect"), Some(OpRole::Terminal { void: false }));
    assert_eq!(op_role("iterator"), Some(OpRole::LazyTerminal));
    assert_eq!(op_role("orElse"), None);
}
#[test] fn sources() {
    assert_eq!(classify_source(Some("nums"), "stream", false), Some(SourceCheck::Fresh));
    assert_eq!(classify_source(Some("java.util.stream.Stream"), "generate", false), Some(SourceCheck::Stateful));
    assert_eq!(classify_source(Some("Files"), "lines", false), Some(SourceCheck::Rereads));
    assert_eq!(classify_source(Some("reader"), "lines", false), Some(SourceCheck::Rereads));
    assert_eq!(classify_source(Some("\"a\\nb\""), "lines", true), Some(SourceCheck::Fresh));
    assert_eq!(classify_source(Some("rnd"), "ints", false), Some(SourceCheck::Stateful));
    assert_eq!(classify_source(None, "stream", false), None);
    assert_eq!(classify_source(Some("repo"), "findAll", false), None);
}
#[test] fn trace_value_json_shape() {
    let v = TraceValue::Boxed { id: 7, class: BoxKind::Int, value: "5".into() };
    assert_eq!(serde_json::to_string(&v).unwrap(), r#"{"kind":"boxed","id":7,"class":"int","value":"5"}"#);
}
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-streams` → FAIL.
- [ ] **Step 3: Cài đặt** hai module và `lib.rs` (`pub use model::*;`).
- [ ] **Step 4: Chạy lại**: `cargo test -p ide-streams` → PASS.
- [ ] **Step 5: Commit**: `git add Cargo.toml Cargo.lock crates/ide-streams && git commit -m "feat(debugger): add the ide-streams crate with stream operation tables"`

---

### Task 3: Tìm chuỗi quanh dòng dừng

**Files:**

- Create: `crates/ide-streams/src/chain.rs`, `crates/ide-streams/tests/fixtures/Chains.java`, `crates/ide-streams/tests/chains.rs`
- Modify: `crates/ide-streams/src/lib.rs`

**Interfaces:**

- Consumes: `StructureService::with_tree` (Task 1), `op_role`, `classify_source` (Task 2).
- Produces:

```rust
pub struct StopContext<'a> { pub line: u32, pub in_lambda: bool, pub file_stem: &'a str }
pub fn find_chains(service: &StructureService, snap: &Snapshot, stop: &StopContext, cancel: &CancellationToken) -> StructureResult<ChainSearch>
pub struct ChainSearch { pub chains: Vec<StreamChain>, pub rejected: Vec<RejectedChain> }        // cả hai theo thứ tự nguồn
pub struct RejectedChain { pub range: Range, pub text: String, pub reason: Rejection }
pub struct StreamChain { pub range: Range, pub text: String, pub root: ChainRoot, pub ops: Vec<ChainOp>,
    pub terminal: ChainOp, pub frame: FrameShape, pub warnings: Vec<ChainWarning>, pub facts: ChainFacts }
pub struct ChainRoot { pub text: String, pub span: (usize, usize) }           // span: byte, tương đối với StreamChain.text
pub struct ChainOp { pub name: String, pub role: OpRole, pub span: (usize, usize) }   // span từ dấu "." tới ")" của lời gọi
pub struct FrameShape { pub record: bool, pub class_path: Vec<String>, pub type_params: Vec<(String, Option<String>)>, pub package: Option<String> }
pub enum FrameKind { Anonymous, Local, SecondaryTopLevel }
pub enum ChainWarning { ParallelRemoved, StatefulSource { call: String }, RereadsResource { call: String } }
pub enum Rejection { RootNotNewStream { root: String }, LazyTerminal { op: String }, UnknownOperation { op: String },
    InsideChainLambda, UnsupportedFrame { frame: FrameKind }, SyntaxError,
    PrivateMethodInLambda { name: String }, SuperMethodReference, SwitchExpression, PatternNotRewritable,
    UnqualifiableType { name: String }, ReservedIdentifier { name: String }, MissingTypeHint { name: String } }
```

`ChainFacts` khai báo rỗng ở task này (`#[derive(Default)]`), Task 4–5 thêm trường. `class_path` là chuỗi lớp bao từ ngoài vào (`["Sample", "Inner"]`); `type_params` là tham số kiểu của method bao rồi của lớp, kèm erasure của bound (`("T", Some("Comparable"))`).

Quy tắc (đã đo ở Q1):

1. Scope: `in_lambda == false` → method/constructor/initializer trong cùng chứa dòng, **bỏ qua lambda**; `true` → mọi lambda có thân phủ dòng (trên một dòng có thể có nhiều lambda lồng nhau, như `C_INNER`). Ứng viên = `method_invocation` có tên là phép kết thúc mà scope trong cùng của nó (lambda hoặc method gần nhất) là một trong các scope trên, câu lệnh hoặc thân lambda bao quanh phủ dòng dừng, và không phải `object` của một lời gọi khác (lời gọi ngoài cùng của chuỗi).
2. Đi xuống theo trường `object`: lời gọi thấp nhất mà `classify_source` nhận là nguồn (gần phép kết thúc nhất) là gốc. Không có nguồn: nếu chuỗi có ít nhất một phép trung gian → `RootNotNewStream { root: <văn bản receiver thấp nhất> }`, nếu không (vd `Collectors.toList()`, `toList()`) → bỏ qua im lặng. Tên giữa gốc và phép kết thúc mà `op_role` trả `None` → `UnknownOperation`.
3. `LazyTerminal` → từ chối. Chuỗi hoặc tổ tiên tới câu lệnh `has_error()` → `SyntaxError`.
4. Frame: tổ tiên là thân `object_creation_expression` → `Anonymous`; `class_declaration` trong `block` → `Local`; lớp/record top-level khác tên `file_stem` → `SecondaryTopLevel`; ba loại này từ chối **mọi** chuỗi (peek của bộ ghi là lambda, Q2). `in_lambda` và dòng nằm trong lambda là đối số của một phép trong chuỗi bao, mà thân lambda đó không có chuỗi → `InsideChainLambda`.
5. Cảnh báo: có `parallelStream`/`.parallel()`/`.sequential()` → `ParallelRemoved`; `SourceCheck::Stateful` → `StatefulSource`; `Rereads` → `RereadsResource`; `Stream.iterate`/`IntStream.iterate`… có đối số là method reference, hoặc lambda dùng định danh không phải tham số của nó → `StatefulSource`.

Fixture `Chains.java` (viết mới, package `demo`, `import java.util.*; import java.util.stream.*; import static java.util.stream.Collectors.toList;`), mỗi marker một dòng; bảng là đáp án của test:

| Marker                                                                                                               | `in_lambda`  | Kết quả                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `C_NEW` `nums.stream().filter(x -> x % 2 == 0).map(x -> x * LIMIT).collect(Collectors.toList())`                     | false        | 1 chuỗi, root `nums.stream()`, ops `["filter","map"]`, terminal `collect`                            |
| `C_STATIC_IMPORT` `nums.stream().map(x -> x + 1).collect(toList())`                                                  | false        | đúng 1 chuỗi, ops `["map"]`                                                                          |
| `C_VARIABLE` `given.filter(s -> !s.isEmpty()).count()`                                                               | false        | 0 chuỗi; rejected `RootNotNewStream { root: "given" }`                                               |
| `C_INT` `IntStream.range(0, 10).map(i -> i * i).sum()`                                                               | false        | root `IntStream.range(0, 10)`, terminal `sum`                                                        |
| `C_ITERATOR` `nums.stream().map(x -> x + 1).iterator()`                                                              | false        | rejected `LazyTerminal { op: "iterator" }`                                                           |
| `C_PARALLEL` `nums.parallelStream().sequential().map(x -> x).parallel().toList()`                                    | false        | ops `["sequential","map","parallel"]` (role Modifier/Step/Modifier), warnings `[ParallelRemoved]`    |
| `C_GENERATE` `Stream.generate(Math::random).limit(3).toList()`                                                       | false        | warnings `[StatefulSource { call: "Stream.generate(Math::random)" }]`                                |
| `C_LINES` `reader.lines().count()` và `"a\nb".lines().count()` (hai câu lệnh, hai dòng)                              | false        | dòng 1: `RereadsResource`; dòng 2: không cảnh báo                                                    |
| `C_MULTI` dòng `.filter(y -> y > 0)` của chuỗi 4 dòng `nums.stream()\n.map(...)\n.filter(y -> y > 0)\n.collect(...)` | false        | 1 chuỗi, ops `["map","filter"]`                                                                      |
| `C_IN_LAMBDA` dòng `return y + LIMIT;` trong lambda khối của `.map(x -> { ... })`                                    | true         | 0 chuỗi; rejected `InsideChainLambda`                                                                |
| `C_INNER` `xs.stream().map(x -> ys.stream().filter(y -> y < x).count()).toList()`                                    | false / true | false: 1 chuỗi (ngoài); true: 1 chuỗi `ys.stream()…count()`                                          |
| `C_TWO` `long a1 = xs.stream().count(), a2 = ys.stream().filter(y -> y > 0).count();`                                | false        | 2 chuỗi theo thứ tự                                                                                  |
| `C_FOREACH` `nums.stream().forEach(x -> System.out.println(x));`                                                     | false        | terminal role `Terminal { void: true }`                                                              |
| `C_OPTIONAL` `Optional.of(1).map(x -> x + 1).filter(x -> x > 0).orElse(0)`                                           | false        | 0 chuỗi, 0 rejected                                                                                  |
| `C_NO_TERMINAL` `var s = nums.stream().map(x -> x);`                                                                 | false        | 0 chuỗi, 0 rejected                                                                                  |
| `C_BROKEN` `nums.stream().map(x -> x +).toList();` và một chuỗi đúng ở dòng sau                                      | false        | dòng lỗi: rejected `SyntaxError`; dòng sau: 1 chuỗi                                                  |
| `C_ANON` chuỗi trong `run()` của `new Runnable() {…}`                                                                | false        | rejected `UnsupportedFrame { frame: Anonymous }`                                                     |
| `C_LOCAL` chuỗi trong method của lớp khai báo trong thân method                                                      | false        | rejected `UnsupportedFrame { frame: Local }`                                                         |
| `C_SECONDARY` chuỗi trong `class Secondary` top-level cùng file                                                      | false        | rejected `UnsupportedFrame { frame: SecondaryTopLevel }`                                             |
| `C_UTF16` `String s = "é😀"; long c = nums.stream().count();`                                                        | false        | `chain.range.start.col` = số đơn vị UTF-16 trước `nums` trên dòng (test tự tính bằng `encode_utf16`) |

- [ ] **Step 1: Viết test thất bại** `tests/chains.rs`: helper `search(marker: &str, in_lambda: bool) -> ChainSearch` (đọc fixture, tìm dòng chứa `// <marker>`, `file_stem = "Chains"`, service như `ide-syntax` tests: `StructureService::new(Arc::new(SyntaxCache::new(Arc::new(Syntax::new()))))`). Một test mỗi dòng bảng, đặt tên theo hành vi; trong đó bắt buộc có `multi_line_chain_found_from_a_middle_line` (C_MULTI), `collector_calls_are_not_chains` (C_NEW, C_STATIC_IMPORT, C_OPTIONAL: đúng số chuỗi, không rejected), `syntax_error_rejects_only_the_broken_chain` (C_BROKEN).
- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-streams --test chains` → FAIL.
- [ ] **Step 3: Cài đặt** `find_chains` theo quy tắc 1–5.
- [ ] **Step 4: Chạy lại**: `cargo test -p ide-streams` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-streams && git commit -m "feat(debugger): find traceable stream chains around the stopped line"`

---

### Task 4: Chuẩn hoá cục bộ (quy tắc 2, 4, 5, 6, song song, định danh dành riêng)

**Files:**

- Create: `crates/ide-streams/src/facts.rs`, `crates/ide-streams/src/normalize.rs`, `crates/ide-streams/tests/normalize.rs`
- Modify: `crates/ide-streams/src/chain.rs` (gọi `facts::collect` khi còn cây), `src/lib.rs`

**Interfaces:**

- Consumes: `StreamChain`, `ChainOp.span`, `FrameShape` (Task 3).
- Produces:

```rust
pub struct ChainFacts { pub edits: Vec<TextEdit>, pub blockers: Vec<Rejection> }        // Task 5 thêm captures, queries
pub struct TextEdit { pub start: usize, pub end: usize, pub text: String, pub adjustment: Adjustment }   // byte, tương đối StreamChain.text
pub enum Adjustment { LambdaParamTypesRemoved, StaticQualified { name: String, with: String }, PatternRewritten { name: String },
    ParallelRemoved, CaptureAliased { name: String, as_type: String }, CaptureRaw { name: String, erasure: String },
    PrimitiveBoxed { text: String }, TypeQualified { name: String, with: String }, GenericCast { name: String, to: String } }
pub struct TypeHints(pub HashMap<u32, String>);                       // TypeQuery.id → kiểu khai báo (văn bản Java)
pub fn normalize(chain: &StreamChain, hints: &TypeHints) -> Result<NormalizedChain, Rejection>
pub struct NormalizedChain { pub prelude: String, pub root: String, pub segments: Vec<Segment>, pub adjustments: Vec<Adjustment> }
pub struct Segment { pub text: String, pub role: OpRole, pub label: String }      // text bắt đầu bằng "."
impl NormalizedChain { pub fn plain_text(&self) -> String }                      // prelude + root + segments, không peek (cho test và hộp thoại)
```

`blockers` = lý do từ chối chỉ phát hiện được khi gom facts; `normalize` trả blocker đầu tiên.

Quy tắc (từ C2 và Q2):

- Quy tắc 2: tham số lambda dạng `formal_parameters` → chỉ giữ tên: `(Integer x)` → `(x)`, `(final Integer a, Integer b)` → `(a, b)`, `(var x)` → `(x)`.
- Quy tắc 4: **chỉ trong thân lambda**, định danh không phải tham số lambda/biến cục bộ/tham số method mà trùng field `static` hoặc là lời gọi không receiver trùng method `static` của một lớp trong `class_path` → `<Lớp.Ngoài>.<Lớp>.<tên>` (lớp khai báo gần nhất). Ngoài lambda giữ nguyên (`sCount` ở cấp ngoài chạy được, C2).
- Quy tắc 5: trong thân lambda, lời gọi `priv(…)`/`this.priv(…)` hoặc `this::priv` với `priv` là method `private` của lớp trong `class_path` → `PrivateMethodInLambda { name }`; `super::m` → `SuperMethodReference`. Field private không sao (C2: `x + secret` chạy).
- Quy tắc 6: `switch_expression` ở bất kỳ đâu trong chuỗi → `SwitchExpression`. `instanceof` có pattern tên `q` và vế trái là định danh `o` → bỏ ` q`, thay mọi định danh `q` trong cùng lambda (hoặc cả chuỗi nếu ngoài lambda) bằng `((T) o)`; record pattern hay vế trái không phải định danh → `PatternNotRewritable`.
- Song song: segment Modifier `parallel`/`sequential` bị bỏ; nếu chuỗi có `ParallelRemoved` thì chèn segment `.sequential()` (role `Modifier`, label `"sequential"`) ngay trước phép kết thúc; giữ `parallelStream()` ở gốc (Q3: `.sequential()` cuối thắng).
- Định danh bắt đầu bằng `__oi` hoặc `__c_`, hoặc bằng `__r`, ở bất kỳ đâu trong chuỗi → `ReservedIdentifier { name }`.
- Dựng lại: `root` = văn bản gốc sau edit; mỗi segment = văn bản `span` của op sau edit (bỏ khoảng trắng/chú thích giữa các op); `label` = tên op.

- [ ] **Step 1: Viết test thất bại** `tests/normalize.rs`; helper `norm(src: &str, hints: &[(u32, &str)]) -> Result<NormalizedChain, Rejection>` (lấy chuỗi duy nhất ở dòng có `// HERE`, `file_stem = "Sample"`, frame method). Lớp mẫu: `class Sample extends Base { private static int LIMIT = 3; static int twice(int x) { return x * 2; } private int priv(int a) { return a; } int inst(int a) { return a; } static class Inner { static int K = 1; void g(List<Integer> nums) { … } } }`. Giá trị mong đợi của `plain_text()`:

```rust
#[test] fn lambda_parameter_types_are_dropped()      // "nums.stream().map((Integer x) -> x + 1).toList()" → "nums.stream().map((x) -> x + 1).toList()"
                                                     // "nums.stream().reduce(0, (final Integer a, Integer b) -> a + b)" → "nums.stream().reduce(0, (a, b) -> a + b)"
#[test] fn statics_in_lambdas_are_qualified()        // "nums.stream().map(x -> x * LIMIT + twice(x)).toList()" → "nums.stream().map(x -> x * Sample.LIMIT + Sample.twice(x)).toList()"
                                                     // trong Inner.g: "nums.stream().map(x -> x + K).toList()" → "nums.stream().map(x -> x + Sample.Inner.K).toList()"
                                                     // "Stream.of(LIMIT).map(LIMIT -> LIMIT + 1).toList()" → không đổi (ngoài lambda; tham số che tên)
#[test] fn private_methods_in_lambdas_are_rejected()  // map(x -> priv(x)), map(x -> this.priv(x)), map(this::priv) → Err(PrivateMethodInLambda { name: "priv" }); map(super::inst) → Err(SuperMethodReference); map(this::inst) → Ok, không đổi
#[test] fn instanceof_patterns_are_rewritten()       // "nums.stream().map(x -> o instanceof Point q ? q.x() + x : x).toList()" → "nums.stream().map(x -> o instanceof Point ? ((Point) o).x() + x : x).toList()"
                                                     // "o instanceof Point(int a, int b)" → Err(PatternNotRewritable); "map(x -> switch (x % 2) { case 0 -> \"e\"; default -> \"o\"; })" → Err(SwitchExpression)
#[test] fn parallel_becomes_sequential_before_the_terminal() // "nums.parallelStream().sequential().map(x -> x).parallel().toList()" → "nums.parallelStream().map(x -> x).sequential().toList()", adjustments chứa ParallelRemoved
#[test] fn reserved_identifiers_are_rejected()       // "nums.stream().map(__oiX -> __oiX).toList()" → Err(ReservedIdentifier { name: "__oiX" }); biến cục bộ "__r" dùng trong chuỗi → Err(ReservedIdentifier { name: "__r" })
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-streams --test normalize` → FAIL.
- [ ] **Step 3: Cài đặt** `facts::collect(tree, chain_node, scope, frame) -> ChainFacts` và `normalize` (áp edit theo thứ tự byte giảm dần trong từng span).
- [ ] **Step 4: Chạy lại**: `cargo test -p ide-streams` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-streams && git commit -m "feat(debugger): normalise stream chains for the JDT evaluator"`

---

### Task 5: Chuẩn hoá cần kiểu (quy tắc 3, 7, 8) và gợi ý từ hover

**Files:**

- Create: `crates/ide-streams/src/qualify.rs`
- Modify: `crates/ide-streams/src/facts.rs`, `src/normalize.rs`, `tests/normalize.rs`

**Interfaces:**

- Consumes: `ChainFacts`, `TypeHints`, `normalize` (Task 4), `FrameShape.record/type_params/package` (Task 3).
- Produces:
  - `ChainFacts` thêm `pub captures: Vec<Capture>, pub queries: Vec<TypeQuery>`.
  - `pub struct Capture { pub name: String, pub declared: Option<String>, pub erasure: Option<String>, pub uses: Vec<(usize, usize)>, pub query: Option<u32> }` — `declared` = văn bản kiểu khai báo (`None` với `var`); `erasure` = phần trước `<` của kiểu khai báo, hoặc tên lớp của initializer `new X<>(…)`; `uses` = vị trí trong thân lambda.
  - `pub struct TypeQuery { pub id: u32, pub name: String, pub pos: Pos }` — `pos` là tên ở chỗ khai báo (UTF-16).
  - `pub fn parse_hover_declared_type(hover: &str, name: &str) -> Option<String>` — dòng đầu dạng `"<Type> <name> - <owner>"`.
  - `pub(crate) fn qualify_type(simple: &str, file: &FileImports) -> Option<String>`; `pub(crate) struct FileImports { package: Option<String>, single: Vec<String>, wildcard: Vec<String>, local_types: Vec<String> }`.

Quy tắc:

- Quy tắc 3: biến cục bộ/tham số method có kiểu chứa `<`, hoặc `var` mà có dùng trong thân lambda của chuỗi → prelude `<Erasure> __c_<name> = <name>; `, mỗi `use` → `((<Declared>) __c_<name>)`. `var`: phát `TypeQuery`; có gợi ý → dùng gợi ý làm `Declared` (`CaptureAliased`); không gợi ý mà có `erasure` → alias thô, mỗi `use` → `__c_<name>` (`CaptureRaw`); không có cả hai → `MissingTypeHint { name }`. Biến chỉ dùng ngoài lambda, hay kiểu không chứa `<` (kể cả biến kiểu `T`), giữ nguyên (C2: `best` kiểu `T` chạy).
- Quy tắc 7: chỉ ngoài thân lambda, phần tử của `new Object[]{…}`: literal `1` → `Integer.valueOf(1)`, `5L` → `Long.valueOf(5L)`, `1.5` → `Double.valueOf(1.5)`, `1.5f` → `Float.valueOf(1.5f)`, `'c'` → `Character.valueOf('c')`, `true` → `Boolean.valueOf(true)`; định danh là biến kiểu primitive khai báo tường minh → `<Box>.valueOf(name)`; phần tử khác giữ nguyên. Không dùng cast `(Object)` (Q2: không chạy).
- Quy tắc 8, frame record (`FrameShape.record`), tính trong `facts::collect` vì cần import của file (kết quả là `TextEdit` hoặc blocker; `Capture.erasure` lưu sẵn tên đầy đủ): mọi tên kiểu đơn giản trong chuỗi (định danh viết hoa ở vị trí `object` của lời gọi/field mà không phải biến, `type_identifier`, vế trái `Type::m`) và erasure của alias quy tắc 3 → tên đầy đủ qua `qualify_type`: import đơn → tên đó; kiểu khai báo trong file → `<package>.<Tên>`; `java.lang` (bảng tên lớp của gói) → giữ nguyên; import wildcard của `java.util`, `java.util.stream`, `java.util.function` → tra bảng tên công khai của ba gói đó (viết tay từ Javadoc API); còn lại → `UnqualifiableType { name }`.
- Quy tắc 8, frame generic: tham số lambda mà kiểu phần tử là biến kiểu `T` có bound → mọi dùng tham số trong thân lambda → `((<BoundErasure>) t)` (`GenericCast`). Kiểu phần tử chỉ suy khi gốc là `<x>.stream()`/`Arrays.stream(<x>)` với `x` khai báo `List<T>`/`Collection<T>`/`Set<T>`/`T[]` và các op trước lambda chỉ là `filter sorted distinct peek limit skip takeWhile dropWhile`; không suy được thì giữ nguyên.

- [ ] **Step 1: Viết test thất bại** (thêm vào `tests/normalize.rs`):

```rust
#[test] fn generic_captures_get_a_raw_alias()   // f(Map<String, List<Integer>> m, List<Integer> nums): "nums.stream().flatMap(x -> m.get(\"a\").stream()).toList()"
    // → prelude "Map __c_m = m; ", plain_text "Map __c_m = m; nums.stream().flatMap(x -> ((Map<String, List<Integer>>) __c_m).get(\"a\").stream()).toList()"
#[test] fn var_capture_uses_the_hover_hint()    // "var list = new ArrayList<>(nums);" + "nums.stream().peek(x -> list.add(x)).count()"
    // chain.facts.queries == [TypeQuery { id: 0, name: "list", pos: <vị trí "list" ở khai báo> }]
    // hints {0: "ArrayList<Integer>"} → "ArrayList __c_list = list; nums.stream().peek(x -> ((ArrayList<Integer>) __c_list).add(x)).count()"
    // không hint → "ArrayList __c_list = list; nums.stream().peek(x -> __c_list.add(x)).count()", adjustments chứa CaptureRaw { name: "list", erasure: "ArrayList" }
    // "var xs = List.of(1, 2);" dùng trong lambda, không hint → Err(MissingTypeHint { name: "xs" })
#[test] fn plain_captures_stay()                // int k, String[] arr, T best dùng trong lambda → không prelude
#[test] fn primitives_in_object_arrays_are_boxed_outside_lambdas() // long big; int k:
    // "Arrays.asList(new Object[]{ big, k, \"s\", 5L, 'c' }).stream().count()" → "Arrays.asList(new Object[]{ Long.valueOf(big), Integer.valueOf(k), \"s\", Long.valueOf(5L), Character.valueOf('c') }).stream().count()"
    // "nums.stream().map(x -> new Object[]{ x, big }).count()" → không đổi
#[test] fn record_frames_use_qualified_names()  // file "package demo; import java.util.stream.*; import java.util.List; public record Point(int x, int y) { … }", stem "Point":
    // "Stream.of(x, y).mapToInt(i -> i).sum()" → "java.util.stream.Stream.of(x, y).mapToInt(i -> i).sum()"
    // "List.of(x).stream().collect(Collectors.toList())" → "java.util.List.of(x).stream().collect(java.util.stream.Collectors.toList())"
    // "Stream.of(Integer.valueOf(x)).count()" → "java.util.stream.Stream.of(Integer.valueOf(x)).count()"
    // với "import com.acme.*;" và "Foo.items().stream().count()" → Err(UnqualifiableType { name: "Foo" })
#[test] fn generic_frames_cast_to_the_bound()   // "static <T extends Comparable<T>> long c(List<T> xs, T best) { return xs.stream().filter(t -> t.compareTo(best) > 0).count(); }"
    // → "xs.stream().filter(t -> ((Comparable) t).compareTo(best) > 0).count()"; với "<T>" không bound → không đổi
#[test] fn hover_text_gives_the_declared_type() {
    assert_eq!(parse_hover_declared_type("ArrayList<Integer> list - demo.Main.run(List<Integer>, int)", "list").as_deref(), Some("ArrayList<Integer>"));
    assert_eq!(parse_hover_declared_type("Map<String, List<Integer>> m - demo.Main.run(List<Integer>, int)", "m").as_deref(), Some("Map<String, List<Integer>>"));
    assert_eq!(parse_hover_declared_type("int k - demo.Main.run(List<Integer>, int)", "list"), None);
}
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-streams --test normalize` → FAIL.
- [ ] **Step 3: Cài đặt** các quy tắc trên trong `facts.rs`/`normalize.rs`/`qualify.rs`.
- [ ] **Step 4: Chạy lại**: `cargo test -p ide-streams` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-streams && git commit -m "feat(debugger): normalise type-dependent stream chain constructs"`

---

### Task 6: Sinh E0/E1/E3

**Files:**

- Create: `crates/ide-streams/src/generate.rs`, snapshot dưới `crates/ide-streams/src/snapshots/`
- Modify: `crates/ide-streams/src/lib.rs`

**Interfaces:**

- Consumes: `NormalizedChain`, `Segment`, `OpRole` (Task 4).
- Produces:

```rust
pub const DEFAULT_BUDGET_ENTRIES: usize = 100_000;
pub struct TracePlan { pub nonce: String, pub key: String, pub e0: String, pub e1: String, pub e3: String,
    pub steps: Vec<StepInfo>, pub terminal: String, pub void_terminal: bool, pub budget: usize }
pub struct StepInfo { pub index: u16, pub label: String, pub kind: StepKind }    // index 0 = nguồn (label = văn bản gốc, kind Sync)
pub fn build_plan(chain: &NormalizedChain, nonce: &str, budget: usize) -> TracePlan
pub fn fresh_nonce() -> String                                                  // 16 hex thường, từ RandomState
```

Văn bản cố định (đã chạy ở Q3, chỉ tách thông điệp ném):

- `key` = `oi.<nonce>`; `e0` = `System.getProperties().put("oi.<nonce>", new java.util.ArrayList())`; `e3` = `System.getProperties().remove("oi.<nonce>")`.
- peek bước `k` (sau nguồn: `k = 0`; sau mỗi segment role `Step`: `k` tăng dần; không có sau `Modifier`):
  `.peek(__oiX -> { if (__oi.size() >= <budget>) throw new IllegalStateException("oi-budget:<nonce>"); if (Thread.currentThread() != __oiT) throw new IllegalStateException("oi-thread:<nonce>"); __oi.add(Integer.valueOf(<k>)); __oi.add(__oiX); })`
- `e1` = `java.util.ArrayList __oi = (java.util.ArrayList) System.getProperties().get("oi.<nonce>"); Thread __oiT = Thread.currentThread(); <prelude>Object __r = <chuỗi có peek>; __oi.add(Integer.valueOf(-1)); __oi.add(__r); return __r;`
- Phép kết thúc `void`: `... <prelude><chuỗi có peek>; Object __r = null; __oi.add(Integer.valueOf(-1)); __oi.add(__r); return __r;`

- [ ] **Step 1: Viết test thất bại** (`generate.rs`), chuỗi dựng từ `norm` của Task 4 (`nums.stream().filter(x -> x % 2 == 0).map(x -> x * k).collect(Collectors.toList())`):

```rust
#[test] fn e1_snapshot() { insta::assert_snapshot!(build_plan(&chain, "n1", DEFAULT_BUDGET_ENTRIES).e1); }
#[test] fn e0_e3_and_steps() {
    let p = build_plan(&chain, "n1", DEFAULT_BUDGET_ENTRIES);
    assert_eq!(p.e0, r#"System.getProperties().put("oi.n1", new java.util.ArrayList())"#);
    assert_eq!(p.e3, r#"System.getProperties().remove("oi.n1")"#);
    assert_eq!(p.steps.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["nums.stream()", "filter", "map"]);
    assert_eq!(p.terminal, "collect");
    assert_eq!(p.e1.matches(".peek(__oiX").count(), 3);
}
#[test] fn void_terminal_still_writes_the_terminator()   // forEach: e1 kết thúc bằng "; Object __r = null; __oi.add(Integer.valueOf(-1)); __oi.add(__r); return __r;"
#[test] fn modifiers_get_no_peek()                       // chuỗi C_PARALLEL đã chuẩn hoá: peek(0) sau gốc, peek(1) sau map, "…peek(1…).sequential().toList()"
#[test] fn custom_budget()                               // budget 1000 → e1 chứa "__oi.size() >= 1000"
#[test] fn nonces_are_fresh() { let (a, b) = (fresh_nonce(), fresh_nonce()); assert_ne!(a, b); assert_eq!(a.len(), 16); assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())); }
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-streams generate` → FAIL.
- [ ] **Step 3: Cài đặt**; chấp nhận snapshot sau khi đọc và đối chiếu với văn bản cố định ở trên (`cargo insta review` hoặc đổi tên file `.snap.new`).
- [ ] **Step 4: Chạy lại**: `cargo test -p ide-streams` → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-streams && git commit -m "feat(debugger): build the peek-recording trace expressions"`

---

### Task 7: Resolver

**Files:**

- Create: `crates/ide-streams/src/resolve.rs`
- Modify: `crates/ide-streams/src/lib.rs`

**Interfaces:**

- Consumes: `Record`, `TraceValue`, `StepKind`, `Link`, `DistinctDrop` (Task 2).
- Produces:
  - `pub fn resolve(kinds: &[StepKind], records: &[Record]) -> Vec<Link>` — `kinds[i]` là phép giữa bước `i` và `i + 1`; kết quả song song với `records`.
  - `pub fn sorted_pass_through(records: &[Record], step: u16) -> bool` — có bản ghi bước `step` đứng trước bản ghi cuối của bước `step - 1`.
  - `pub fn distinct_drops(records: &[Record], links: &[Link], step: u16) -> Vec<DistinctDrop>` — bản ghi bước `step - 1` không có con ở bước `step`; `same_as` = bản ghi giữ lại sớm nhất cùng bước có giá trị bằng (Boxed: cùng `class` và `value`; Str không `truncated`: cùng `value`; Null), Object → `None` (S2 gọi `equals` ở E2).

Thuật toán (Q4):

- `Sync`: cha = bản ghi bước trước có chỉ số lớn nhất nhỏ hơn chỉ số của bản ghi.
- `Reorder`: khoá = `value` (kèm `class`) với `Boxed`, `id` với `Object`/`Str`, một khoá riêng cho `Null`; hàng đợi FIFO theo khoá trên bản ghi bước trước; `ambiguous = true` khi khoá xuất hiện hơn một lần ở bước trước.
- `Unlinked`: không có cha.

- [ ] **Step 1: Viết test thất bại** (helper `o(id)`, `int(id, v)`, `s(id, text)`, `r(step, value)`):

```rust
#[test] fn sync_links_to_the_nearest_earlier_record()   // kinds [Sync, Sync]; [r(0,o(1)), r(0,o(2)), r(1,o(2)), r(2,o(3)), r(0,o(4))] → parents [None, None, Some(1), Some(2), None]
#[test] fn flat_map_children_link_to_their_element()    // [Sync]; [r(0,o(1)), r(1,o(5)), r(1,o(6)), r(0,o(2)), r(1,o(7))] → [None, Some(0), Some(0), None, Some(3)]
#[test] fn skip_with_shared_cached_integers()           // [Sync]; ba lần r(0,int(7,1)) rồi r(1,int(7,1)) → links[3].parent == Some(2)
#[test] fn sorted_matches_objects_by_identity()         // [Reorder]; [r(0,o(1)), r(0,o(2)), r(0,o(3)), r(1,o(3)), r(1,o(1)), r(1,o(2))] → [.., Some(2), Some(0), Some(1)], ambiguous đều false
#[test] fn sorted_matches_boxes_by_value_in_order()     // [Reorder]; [r(0,int(11,300)), r(0,int(12,1)), r(0,int(13,300)), r(1,int(14,1)), r(1,int(15,300)), r(1,int(16,300))]
                                                        // → links[3] = (Some(1), false), links[4] = (Some(0), true), links[5] = (Some(2), true)
#[test] fn sorted_then_limit()                          // [Reorder, Sync]; [r(0,o(5)), r(0,o(3)), r(0,o(8)), r(0,o(1)), r(1,o(1)), r(2,o(1)), r(1,o(3)), r(2,o(3))] → [None×4, Some(3), Some(4), Some(1), Some(6)]
#[test] fn unlinked_ops_have_no_parents()
#[test] fn pass_through_sort_is_detected()              // [r(0,a), r(1,a), r(0,b), r(1,b)] → true; [r(0,a), r(0,b), r(1,b), r(1,a)] → false
#[test] fn distinct_drops_find_equal_values()           // [r(0,s(1,"a")), r(1,s(1,"a")), r(0,s(2,"b")), r(1,s(2,"b")), r(0,s(3,"a"))] → [DistinctDrop { dropped: 4, same_as: Some(0) }]
                                                        // [r(0,o(1)), r(1,o(1)), r(0,o(2))] → [DistinctDrop { dropped: 2, same_as: None }]
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-streams resolve` → FAIL.
- [ ] **Step 3: Cài đặt** ba hàm (O(n) mỗi bước, như probe).
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-streams && git commit -m "feat(debugger): link traced stream elements across steps"`

---

### Task 8: Giải mã bản ghi và kết quả E1

**Files:**

- Create: `crates/ide-streams/src/decode.rs`
- Modify: `crates/ide-streams/src/lib.rs`

**Interfaces:**

- Consumes: `TracePlan` (Task 6), `sorted_pass_through` (Task 7).
- Produces:

```rust
pub struct Recording { pub entries: Vec<TraceValue>, pub total_len: usize }     // total_len = ArrayList.size thật
pub struct E1Value { pub type_name: String, pub text: String }                  // DAP evaluate body.type / body.result
pub fn decode(plan: &TracePlan, recording: &Recording, e1: &E1Value) -> Result<DecodedTrace, DecodeError>
pub struct DecodedTrace { pub records: Vec<Record>, pub outcome: Outcome, pub banners: Vec<Banner> }
pub enum Outcome { Completed { result: Option<TraceValue> }, Threw { message: String }, BudgetExceeded, WrongThread }
pub enum Banner { CountFromSize, SortedPassThrough { step: u16 }, Truncated { read: usize, total: usize } }
pub enum DecodeError { Malformed { at: usize } }
pub enum EvalFailure { GenericCapture, UnqualifiedStatic, UnsupportedFrame, NotVisible { member: String }, UnresolvedName { name: String }, Other { message: String } }
pub fn classify_eval_error(message: &str) -> EvalFailure
```

Quy tắc:

- Đọc theo cặp `(marker, value)`; marker phải là `Boxed { class: Int }` với giá trị trong `0..plan.steps.len()` hoặc `-1`. `-1` là dấu kết thúc, phải là cặp cuối. Sai → `Malformed { at: <chỉ số mục> }`.
- `entries.len() < total_len` → chỉ giữ số mục chẵn, banner `Truncated { read, total }`; outcome lấy từ `e1`: thông điệp của ta → như dưới; `type_name` kết thúc bằng `Exception`/`Error` hoặc là `Throwable` → `Threw`; còn lại `Completed { result: None }`. Không bị cắt mà số mục lẻ → `Malformed`.
- Có dấu kết thúc → `Completed { result: Some(<value sau -1>) }`. Không có: `e1.text` chứa `oi-budget:<nonce>` → `BudgetExceeded`; chứa `oi-thread:<nonce>` → `WrongThread` (ForkJoin bọc ngoại lệ, Q3: so bằng `contains`); còn lại → `Threw { message }`, `message` = phần trong cặp `"` đầu và cuối của `e1.text` nếu có dạng `Type@id "…"`, nếu không là cả `text`.
- `Completed`, `plan.terminal == "count"`, có ít nhất một bước sau nguồn, và không có bản ghi nào → `CountFromSize`. Mỗi bước `Reorder` mà `sorted_pass_through` → `SortedPassThrough { step }`.
- `classify_eval_error` (chuỗi thật từ Q2/C2): chứa `<java cannot be resolved to a type` → `GenericCapture`; chứa `ModuleBinding.canAccess` → `UnqualifiedStatic`; chứa `Functional expressions cannot be evaluated inside local and or anonymous classes` → `UnsupportedFrame`; `The method <m>(…) from the type <T> is not visible` → `NotVisible { member: m }`; `<Name> cannot be resolved` → `UnresolvedName { name }`; còn lại `Other`.

- [ ] **Step 1: Viết test thất bại** (`plan` dựng bằng `build_plan` từ chuỗi Task 6, nonce `"n1"`; helper `int(id, v)`, `o(id)`):

```rust
#[test] fn completed_trace()        // plan 2 bước (nguồn + filter); entries [int(1,0), o(10), int(2,1), o(10), int(1,0), o(11), int(3,-1), o(99)], total 8
                                    // → records [(0,o(10)), (1,o(10)), (0,o(11))], Completed { result: Some(o(99)) }, banners []
#[test] fn budget_and_thread_guards() {
    // không dấu kết thúc; e1 "IllegalStateException@447 \"java.lang.IllegalStateException: oi-budget:n1\"" → BudgetExceeded
    // e1 "IllegalStateException@349 \"java.lang.IllegalStateException: java.lang.IllegalStateException: oi-thread:n1\"" → WrongThread
    // e1 "...oi-budget:zz..." → Threw (nonce khác)
}
#[test] fn user_exception()         // e1 { type_name: "ArithmeticException", text: "ArithmeticException@525 \"java.lang.ArithmeticException: / by zero\"" } → Threw { message: "java.lang.ArithmeticException: / by zero" }
#[test] fn count_from_size()        // terminal count, entries [int(3,-1), Boxed{Long,"7"}] → Completed, banners [CountFromSize]
#[test] fn truncated_recording_keeps_whole_pairs()  // 7 mục, total_len 10 → 3 bản ghi, banner Truncated { read: 6, total: 10 }
#[test] fn odd_recording_is_malformed()  // 3 mục, total_len 3 → Err(Malformed { at: 2 }); marker int(1,7) với 2 bước → Err(Malformed { at: 0 }); marker Str → Malformed; cặp sau -1 → Malformed
#[test] fn sorted_pass_through_banner()  // plan có sorted, bản ghi xen kẽ → banners [SortedPassThrough { step: 1 }]
#[test] fn eval_errors() {
    assert_eq!(classify_eval_error("Cannot evaluate because of compilation error(s): [java.util.ArrayList<java cannot be resolved to a type]."), EvalFailure::GenericCapture);
    assert_eq!(classify_eval_error("Cannot evaluate because of java.lang.NullPointerException: Cannot invoke \"org.eclipse.jdt.internal.compiler.lookup.ModuleBinding.canAccess(org.eclipse.jdt.internal.compiler.lookup.PackageBinding)\" because \"mod\" is null"), EvalFailure::UnqualifiedStatic);
    assert_eq!(classify_eval_error("Cannot evaluate because of compilation error(s): Functional expressions cannot be evaluated inside local and or anonymous classes."), EvalFailure::UnsupportedFrame);
    assert_eq!(classify_eval_error("Cannot evaluate because of compilation error(s): [The method priv(int) from the type Svc is not visible]."), EvalFailure::NotVisible { member: "priv".into() });
    assert_eq!(classify_eval_error("Cannot evaluate because of compilation error(s): Stream cannot be resolved."), EvalFailure::UnresolvedName { name: "Stream".into() });
}
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-streams decode` → FAIL.
- [ ] **Step 3: Cài đặt.**
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-streams && git commit -m "feat(debugger): decode stream trace recordings"`

---

### Task 9: Điều phối E0–E3 qua trait (ranh giới với S2 và M2)

**Files:**

- Create: `crates/ide-streams/src/trace.rs`
- Modify: `crates/ide-streams/src/lib.rs`

**Interfaces:**

- Consumes: `TracePlan` (Task 6), `decode`, `Recording`, `E1Value`, `classify_eval_error` (Task 8), `resolve`, `distinct_drops` (Task 7).
- Produces:

```rust
pub trait Evaluator { fn evaluate(&self, expression: &str) -> impl Future<Output = Result<E1Value, String>> + Send; }   // Err = thông điệp lỗi của adapter
pub trait RecordingReader { fn read(&self, key: &str, limit: usize) -> impl Future<Output = Result<Recording, ReadError>> + Send; }
pub enum ReadError { Unsupported, NotFound, Failed { message: String } }
pub struct TraceResult { pub trace: DecodedTrace, pub links: Vec<Link>, pub drops: Vec<DistinctDrop>, pub cleanup_failed: bool }
pub enum TraceError { Setup { message: String }, Eval(EvalFailure), Read(ReadError), Decode(DecodeError), Cancelled }
pub async fn run_trace<E: Evaluator, R: RecordingReader>(plan: &TracePlan, eval: &E, reader: &R, cancel: &CancellationToken) -> Result<TraceResult, TraceError>
```

`RecordingReader` là thứ S1 cần từ `JvmInspector` của M2; S2 cài nó (đọc `System.props` → entry `oi.<nonce>` → `ArrayList.elementData`/`size` chỉ bằng đọc field, không invoke). Hợp đồng ghi trong doc comment của trait: phần tử theo thứ tự list, tối đa `limit`; `id` = `ObjectReference.uniqueID()`; kiểu bọc kèm field `value`; `String` kèm giá trị (cắt, `truncated`); `total_len` = `size`. Không có VM hay không đọc được → `Unsupported` (S2 có thể dự phòng).

Thứ tự: `cancel` trước E0 → `Cancelled` (không gọi gì). E0 lỗi → vẫn chạy E3, trả `Setup`. E1 `Err(msg)` → E3, trả `Eval(classify_eval_error(msg))`. Huỷ sau E1 → E3, `Cancelled`. E2 `read(key, plan.budget + 2)` lỗi → E3, `Read`. `decode` lỗi → E3, `Decode`. Thành công → `resolve` với `kinds` từ `plan.steps[1..]`, `distinct_drops` cho mỗi bước có label `distinct`, E3; E3 lỗi → `cleanup_failed = true` (không phải lỗi). E3 luôn là lời gọi cuối khi E0 đã được gửi.

- [ ] **Step 1: Viết test thất bại** (`#[tokio::test]`; `FakeEval` ghi lại biểu thức và trả theo kịch bản; `FakeReader` trả `Recording` cố định):

```rust
#[tokio::test] async fn happy_path_runs_e0_e1_e3_in_order()  // calls == [plan.e0, plan.e1, plan.e3]; links như completed_trace của Task 8
#[tokio::test] async fn e3_runs_after_eval_failure()       // E1 Err("...not visible]") → Err(Eval(NotVisible{..})), calls kết thúc bằng plan.e3
#[tokio::test] async fn e3_runs_after_read_failure()       // reader Err(Unsupported) → Err(Read(Unsupported)), calls kết thúc bằng plan.e3
#[tokio::test] async fn cancelled_after_e1_still_cleans()  // token huỷ trong FakeEval khi nhận e1 → Err(Cancelled), calls == [e0, e1, e3], reader không được gọi
#[tokio::test] async fn cleanup_failure_is_only_a_flag()   // E3 Err → Ok, cleanup_failed == true
#[tokio::test] async fn reader_gets_budget_plus_terminator() // limit == plan.budget + 2
```

- [ ] **Step 2: Chạy, xác nhận thất bại**: `cargo test -p ide-streams trace` → FAIL.
- [ ] **Step 3: Cài đặt** `run_trace`.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit**: `git add crates/ide-streams && git commit -m "feat(debugger): run stream traces through evaluator and reader seams"`

---

### Task 10: Property test resolver với oracle JVM

**Files:**

- Create: `crates/ide-streams/tests/fixtures/java/TraceOracle.java`, `crates/ide-streams/tests/fixtures/resolver/oracle-jdk21-seed1.jsonl`, `crates/ide-streams/tests/resolver_oracle.rs`

**Interfaces:**

- Consumes: `resolve`, `Record`, `TraceValue`, `StepKind`; `op_role` qua hàm công khai mỏng `pub fn step_kind(op: &str) -> Option<StepKind>` (thêm vào `catalog.rs`, re-export).

`TraceOracle.java` (viết mới, cú pháp Java 11, `java TraceOracle.java <seed> <count>`): mỗi chuỗi ngẫu nhiên có nguồn `ArrayList` 0–9 phần tử, giá trị trong dải nhỏ (−1..5, trúng cache Integer) hoặc lớn (−150..450), 1–4 phép trong `map filter flatMap mapMulti skip limit distinct sorted takeWhile dropWhile peek` (`sorted` gồm tăng, giảm và theo khoá `v % 3`; `filter` gồm cả lọc có trạng thái; `mapMulti` gọi qua reflection, bỏ khi JDK < 16), `peek` sau nguồn và sau mỗi phép, chạy `collect(Collectors.toList())`. Phần tử là object riêng mang `id`, `v`, `from` (cha); `equals`/`hashCode` theo `v`. In một dòng JSON mỗi chuỗi: `{"ops":["map","sorted"],"records":[[stage,id,v],…],"truth":[-1,0,…]}` (`truth[i]` = chỉ số bản ghi cha, −1 ở bước 0; phép tạo mới dùng `from`, phép khác dùng chính object).

Test suy ba chế độ danh tính từ mỗi dòng (như probe Q4): `ref` → `Object { id }`; `boxed` → `Boxed { Int, v }` với `id` chung theo `v` khi `−128 ≤ v ≤ 127`, ngược lại `id` của object; `prim` → như `boxed` nhưng ngoài dải cache mỗi bản ghi một `id` mới.

- [ ] **Step 1: Sinh fixture**: `$HOME/.sdkman/candidates/java/21.0.4-tem/bin/java crates/ide-streams/tests/fixtures/java/TraceOracle.java 1 500 > crates/ide-streams/tests/fixtures/resolver/oracle-jdk21-seed1.jsonl` → 500 dòng (~100 KB).
- [ ] **Step 2: Viết test** `oracle_fixture_resolves_without_error` (mọi chế độ: số liên kết sai == 0, tổng liên kết ≥ 2000 mỗi chế độ) và `#[ignore] oracle_on_real_jdk` (chạy `TraceOracle.java 1 20000` bằng `OPENIDEA_TEST_JAVA`, cùng kiểm tra, in tổng liên kết).
- [ ] **Step 3: Chạy**: `cargo test -p ide-streams --test resolver_oracle` → PASS (resolver đã có ở Task 7; nếu FAIL là lỗi resolver hoặc oracle, sửa trước khi đi tiếp). Rồi `OPENIDEA_TEST_JAVA=<java> cargo test -p ide-streams --test resolver_oracle -- --ignored` với 11.0.29, 17.0.21 (`scratchpad/jdk17-dl`), 21.0.4, 25.0.3 → PASS, 0 sai (Q4: 431.004 liên kết trên 17/21/25).
- [ ] **Step 4: Commit**: `git add crates/ide-streams/src/catalog.rs crates/ide-streams/src/lib.rs crates/ide-streams/tests/fixtures/java/TraceOracle.java crates/ide-streams/tests/fixtures/resolver/oracle-jdk21-seed1.jsonl crates/ide-streams/tests/resolver_oracle.rs && git commit -m "feat(debugger): property-test the stream resolver against a JVM oracle"`

---

### Task 11: Test vàng chạy mã sinh ra trên JVM thật

**Files:**

- Create: `crates/ide-streams/tests/golden.rs`, `crates/ide-streams/tests/golden_cases.rs` (bảng ca + kỳ vọng, `mod` dùng chung), `crates/ide-streams/tests/fixtures/golden/<case>.json`

**Interfaces:**

- Consumes: toàn bộ API công khai: `find_chains` → `normalize` → `build_plan` → `decode` → `resolve`/`distinct_drops`.

Mỗi ca = khai báo biến cục bộ + một dòng chuỗi. Source "người dùng" dựng trong test: `import java.util.*; import java.util.stream.*; class Golden { static final class K { … } static Object run() { <locals> <dòng chuỗi> // HERE\n return null; } }` (`K`: `equals`/`hashCode` theo `key`, `toString` trả `label`). Pipeline với nonce `"g0"`, không hint.

Test `#[ignore] golden_on_real_jdk` (đọc `OPENIDEA_TEST_JAVA`; thêm `tempfile` vào dev-deps): ghi `Golden.java` vào tempdir gồm `K`, `static Object run() { <locals> <plan.e1> }` và `main`: chạy `plan.e0` như câu lệnh, gọi `run()` trong `try/catch (Throwable t)` (giống evaluate trả ngoại lệ như giá trị), in JSON `{"recording": {"entries": [TraceValue…], "totalLen": n}, "e1": {"typeName": <getSimpleName>, "text": "<SimpleName>@<id> \"<toString>\""}}` (id theo `IdentityHashMap` đếm tăng; `TraceValue` đúng dạng serde của Task 2), rồi chạy `plan.e3` và in `cleaned=true` nếu khoá đã mất. Với `OPENIDEA_UPDATE_GOLDEN=1` ghi JSON vào `tests/fixtures/golden/<case>.json`. Cả test này và test thường `golden_fixtures` (đọc JSON đã commit) đưa JSON qua `run_trace` với `Evaluator` giả (E0/E3 trả `Ok`, E1 trả `e1` của JSON) và `RecordingReader` giả (trả `recording`), rồi gọi chung `expect(case: &Case, chain: &StreamChain, result: &TraceResult)`; test JVM thật assert thêm `cleaned=true`.

| Ca                              | Locals                                                                                  | Chuỗi                                                                            | Kỳ vọng                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `count_sized`                   | `List<Integer> nums = List.of(5, 3, 8, 1);`                                             | `Object o = nums.stream().map(x -> x).count();`                                  | `Completed`, kết quả `Boxed Long "4"`, 0 bản ghi, banners `[CountFromSize]`                              |
| `sorted_noop`                   | `TreeSet<Integer> set = new TreeSet<>(List.of(5, 3, 8, 1));`                            | `Object o = set.stream().sorted().collect(Collectors.toList());`                 | banners `[SortedPassThrough { step: 1 }]`; mỗi bản ghi bước 1 có cha là bản ghi bước 0 ngay trước nó     |
| `sorted_limit`                  | `List<Integer> nums = List.of(5, 3, 8, 1);`                                             | `Object o = nums.stream().sorted().limit(2).collect(Collectors.toList());`       | thứ tự `(step, value)`: `[(0,5),(0,3),(0,8),(0,1),(1,1),(2,1),(1,3),(2,3)]`; cha `[-,-,-,-,3,4,1,6]`     |
| `skip_duplicates`               | `List<Integer> nums = List.of(1, 1, 1);`                                                | `Object o = nums.stream().skip(2).collect(Collectors.toList());`                 | 4 bản ghi; cha của bản ghi bước 1 là chỉ số 2                                                            |
| `distinct_equals_not_tostring`  | `List<K> ks = List.of(new K("a", "first"), new K("b", "second"), new K("a", "third"));` | `Object o = ks.stream().distinct().collect(Collectors.toList());`                | 5 bản ghi; `drops == [DistinctDrop { dropped: 4, same_as: None }]`; bản ghi bước 1 nối tới chỉ số 0 và 2 |
| `exception_mid_stream`          | `List<Integer> nums = List.of(5, 3, 8);`                                                | `Object o = nums.stream().map(x -> 10 / (x - 3)).collect(Collectors.toList());`  | `Threw { message: "java.lang.ArithmeticException: / by zero" }`; `(step, value)` `[(0,5),(1,5),(0,3)]`   |
| `budget_exceeded` (budget 1000) | —                                                                                       | `Object o = Stream.iterate(1, x -> x + 1).filter(x -> x < 0).findFirst();`       | `BudgetExceeded`; 500 bản ghi                                                                            |
| `void_foreach`                  | `List<Integer> nums = List.of(1, 2);`                                                   | `nums.stream().map(x -> x * 2).forEach(x -> System.out.print(x));`               | `Completed { result: Some(Null) }`; 4 bản ghi                                                            |
| `parallel_made_sequential`      | `List<Integer> nums = List.of(1, 2, 3, 4, 5, 6, 7, 8);`                                 | `Object o = nums.parallelStream().map(x -> x + 1).collect(Collectors.toList());` | warnings `[ParallelRemoved]`; `Completed`; 16 bản ghi, bước 1 nối bản ghi ngay trước                     |

- [ ] **Step 1: Viết `golden_cases.rs` và hai test** (`golden_fixtures` FAIL vì chưa có JSON).
- [ ] **Step 2: Sinh fixture**: `OPENIDEA_TEST_JAVA=$HOME/.sdkman/candidates/java/21.0.4-tem/bin/java OPENIDEA_UPDATE_GOLDEN=1 cargo test -p ide-streams --test golden -- --ignored` → PASS, có 9 file JSON.
- [ ] **Step 3: Chạy**: `cargo test -p ide-streams --test golden` → PASS; rồi `--ignored` không `UPDATE` với 11.0.29, 17.0.21, 25.0.3 → PASS (chỉ id khác, kỳ vọng giống).
- [ ] **Step 4: Commit**: `git add crates/ide-streams/Cargo.toml Cargo.lock crates/ide-streams/tests/golden.rs crates/ide-streams/tests/golden_cases.rs crates/ide-streams/tests/fixtures/golden && git commit -m "feat(debugger): golden-test generated stream traces on a real JVM"`

---

### Task 12: Kiểm tra như CI

**Files:** không (sửa lỗi nếu có trong các file trên).

- [ ] **Step 1** (từng lệnh một): `cargo fmt --all --check`; `cargo clippy -p ide-syntax -p ide-streams --all-targets -- -D warnings`; `cargo nextest run -p ide-syntax -p ide-streams`; `cargo nextest run --workspace` → 0 lỗi. Không đổi kiểu IPC nên không cần `pnpm gen:bindings`; không có thay đổi frontend.
- [ ] **Step 2**: chạy lại hai test `--ignored` (Task 10, 11) với JDK 21 và 25; ghi lệnh và kết quả vào mục **How it was verified** của PR (không có ảnh chụp: không đổi giao diện).
- [ ] **Step 3**: mở PR theo `.github/pull_request_template.md` sau khi chủ repo chốt mục "Cần chủ repo quyết định" 2 (mô tả ngắn, `Closes #N` nếu issue chỉ cho S1, nếu không thì `Part of #N`).

---

## S1 giao cho S2

- `find_chains(service, snap, &StopContext { line, in_lambda, file_stem }, cancel)`; `in_lambda` = tên frame DAP chứa `lambda$`.
- `chain.facts.queries` → S2 gọi jdtls `textDocument/hover` tại `pos`, `parse_hover_declared_type`, rồi `normalize(chain, &TypeHints)`.
- `build_plan(&normalized, &fresh_nonce(), DEFAULT_BUDGET_ENTRIES)`; S2 tắt breakpoint, gọi `run_trace` với `Evaluator` (DAP `evaluate` trong frame, timeout phía app) và `RecordingReader` (M2), khôi phục breakpoint.
- Kiểu `ChainSearch`, `Adjustment`, `ChainWarning`, `TraceResult`, `Banner` đã có serde/specta để thành IPC.

## Không làm ở S1 (đã biết, ghi lại để không ai tưởng đã xử lý)

- Static kế thừa từ lớp ở file khác dùng không qualify trong lambda; varargs rỗng (quy tắc 7, cần kiểu); suy kiểu phần tử qua `map` cho frame generic; kiểu từ hover dùng nguyên văn (chưa qualify) trong frame record. Evaluate lỗi thì S2 hiện thông điệp qua `classify_eval_error`.
- `distinct` với object người dùng: `same_as` cần gọi `equals` ở E2 (S2).
- Engine S3/S4, Kotlin `Sequence`.

## Đề xuất sửa spec (đã duyệt và áp vào spec)

- **A1 (§10.1 bước 4):** thay "ném `IllegalStateException("oi-budget")` khi vượt ngân sách … hoặc khi `Thread.currentThread()` khác luồng ghi đầu tiên" bằng: "ném `IllegalStateException("oi-budget:<nonce>")` khi vượt ngân sách và `IllegalStateException("oi-thread:<nonce>")` khi luồng khác luồng chạy E1 (ForkJoin bọc lại ngoại lệ, so bằng `contains`). Sau phép kết thúc, E1 ghi `Integer.valueOf(-1)` rồi kết quả (kể cả phép kết thúc `void`, ghi `null`)." Lý do: Q3 (thông điệp bị bọc `java.lang.IllegalStateException: java.lang.IllegalStateException: oi-budget`; nonce tránh trùng thông điệp của người dùng).
- **A2 (§10.3 quy tắc 9):** thay "nhận diện kết quả kiểu `Throwable`" bằng "không có dấu kết thúc trong bản ghi nghĩa là chuỗi ném ngoại lệ; giá trị E1 là ngoại lệ đó". Lý do: DAP `type` chỉ có tên ngắn (`IllegalStateException`, `ArithmeticException`), không biết được có phải `Throwable`.
- **A3 (§10.4 `sorted`):** thay "khớp theo danh tính cộng thứ tự xuất hiện; đánh dấu "mơ hồ" với primitive trùng" bằng "khớp theo giá trị với kiểu bọc (`Integer`, `Long`, …, và mọi phần tử của `IntStream`/`LongStream`/`DoubleStream` vì mỗi `peek` bọc lại), theo danh tính với object khác, cộng thứ tự xuất hiện; "mơ hồ" khi khoá lặp". Lý do: Q4, chỉ danh tính sai 11.299/431.004 (29% ở `sorted` primitive), cách mới 0.
- **A4 (§10.3 quy tắc 3):** thêm cách sửa đã đo: "`<Erasure> __c_x = x;` trước chuỗi, `((<Kiểu khai báo>) __c_x)` trong lambda; kiểu khai báo từ cú pháp, với `var`/diamond từ jdtls hover (18–22 ms lần đầu, 1–2 ms sau); thiếu thì alias thô". Lý do: Q2.
- **A5 (§10.3 quy tắc 7):** thêm "chỉ áp dụng ngoài thân lambda (trong lambda là bytecode thật, chạy được); cast `(Object)` không thay được `valueOf`". Lý do: Q2.
- **A6 (§10.3 quy tắc 8):** thay "frame class ẩn danh/local/top-level phụ: từ chối lambda" bằng "frame class ẩn danh/local/top-level phụ (kể cả record top-level phụ): từ chối cả trace, vì `peek` của bộ ghi cũng là lambda"; và "frame record (ở file riêng): tên đầy đủ cho mọi kiểu ngoài `java.lang`". Lý do: Q2 (record cùng file `Main.java` báo "Functional expressions cannot be evaluated inside local and or anonymous classes").
- **A7 (§3.1 bảng, dòng `ide-streams`):** phụ thuộc thành "`ide-core`, `ide-syntax` (API mới `with_tree`), `tree-sitter`"; và chốt câu hỏi ở §17 "S1 lấy thông tin kiểu ở đâu": "cú pháp trước; phần còn lại (`var`/diamond) qua `TypeHints`, S2 điền từ jdtls hover".
- **A8 (§10.1 bước 5):** thêm "E2 không dùng được DAP `variables` thay `JvmInspector`: `String` mất danh tính, `Integer` không có giá trị" (Q3, phụ).
- **A9 (§14 dòng `ide-streams`):** "ma trận JDK 11/17/21/25" giữ, ghi chú: S1 đo 17/21/25 cho oracle (thứ tự và đáp án trùng nhau), 11 chạy được nhờ fixture viết cú pháp Java 11 nhưng chưa đo [SL].

## Cần chủ repo quyết định (đã chốt)

Đã chốt: (1) từ chối với `RootNotNewStream`; (2) cùng nhánh `feat/debugger-jvm-memory`, một PR ở cuối; (3) A1–A9 đã duyệt.

1. **Gốc là lời gọi method không có trong danh mục** (`repo.findAll().filter(…).toList()`, có thể trả stream mới hoặc stream đã lưu): mặc định đề xuất **từ chối** với lý do `RootNotNewStream` ở v1 (an toàn: chạy lại stream đã lưu sẽ tiêu thụ nó); S2 có thể thêm nút "Trace anyway" nếu người dùng cần.
2. **PR:** S1 làm trên `feat/debugger-jvm-memory` như yêu cầu, nhưng quy tắc repo là một vấn đề mỗi PR. Đề xuất: commit S1 trên một nhánh `feat/debugger-streams-s1` cắt từ `origin/main` (S1 không phụ thuộc M1), mở PR riêng; tạo issue cần bạn đồng ý (quyết định 7 của spec).
3. **Duyệt A1–A9** trước khi thực thi Task 6 và 8 (A1–A3 đổi văn bản biểu thức và resolver).
