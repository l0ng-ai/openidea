# Stream Debugger S2 (UI + engine A + an toàn phiên) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trong phiên debug Java (java-debug) đang dừng, action `debug.traceStreamChain` trace chuỗi `Stream` quanh dòng dừng bằng engine A (DAP `evaluate` + chuẩn hoá của S1), hiện kết quả Flat/Split có đường nối giữa các bước, không bao giờ làm chết phiên hay mất breakpoint; kèm bộ đo ~30 chuỗi trên JDK 17/21/25 để quyết S3/S4.

**Architecture:** `ide-streams` (thuần tính toán, S1) đổi bộ ghi sang định dạng gọn và thêm pha E2b (`distinct` bằng `equals`). Bundle jdtls `jvm-inspect` thêm lệnh đọc bản ghi theo khúc và lệnh điều khiển thread (huỷ); bundle `java-usages` thêm lệnh lấy kiểu khai báo bằng JDT binding. `ide-dap` điều phối một trace: kiểm năng lực, tắt/khôi phục breakpoint, E0–E3, thang huỷ. `ide-host` tìm chuỗi trên snapshot tài liệu, hỏi kiểu, chuẩn hoá, sinh plan và mở lệnh IPC. Frontend thêm `src/features/debugger/streams/` (state, hộp thoại, action).

**Tech Stack:** Rust (tokio, serde, specta, tree-sitter-java qua `ide-syntax`), Java 21 target (JDI của java-debug 0.53.2, JDT DOM của JDT LS 1.63.0), TypeScript/React (zustand, CSS Modules), vitest, Playwright, smoke `openidea-server`.

**Spec:** `docs/superpowers/specs/2026-11-07-jvm-debug-link-design.md` (§10, §13, §14, §15 thí nghiệm 4–6, §16 R3/R6/R8, §17 mặc định 6). Đọc kèm plan S1 `docs/superpowers/plans/2026-11-07-debugger-streams-s1.md` (mục "S1 giao cho S2") và `.superpowers/sdd/2026-11-07-debugger-streams-s1/progress.md` (các mục "Carry → S2" và "Deferred → S2").

## Global Constraints

- Chỉ phiên có adapter `"java-debug"` và có `StreamProbe` (bundle jdtls) mới có `stream_trace = true`. Phiên `kotlin-lsp`, `kotlin-debug-adapter` và mọi adapter khác: `false`. Khung không phải file `.java`: từ chối `NotJavaFrame`.
- Đọc mảng object qua JDWP (`ArrayReference.getValues`): **mỗi lần ≤ 16.384 phần tử** (`STREAM_READ_CHUNK = 16_384`). 65.537 phần tử trong một lần làm JVM debuggee abort trên 17/21/25 (Grounding G2). Mảng `byte[]`/`char[]` đọc mỗi lần ≤ 1.048.576 phần tử.
- Khoá bộ ghi `oi.<nonce>` trong `System.getProperties()`. Thông điệp ngoại lệ: `oi-budget:<nonce>`, `oi-thread:<nonce>`, `oi-cancel:<nonce>`; so bằng `contains` (ForkJoin bọc lại ngoại lệ).
- Bố cục bộ ghi (thay §10.1 bước 4, xem "Sửa spec đề xuất" 1): `list[0]` là `StringBuilder` chỉ mục, `list[1]` là `RuntimeException("oi-cancel:<nonce>")` tạo ở E0, `list[2..]` là phần tử. `RECORDER_HEADER = 2`.
- Ngân sách: `DEFAULT_BUDGET_RECORDS = 50_000` bản ghi; chỉ mục tối đa `TEXT_BUDGET_CHARS = 2_000_000` ký tự; `String` được chép nguyên văn vào chỉ mục khi độ dài ≤ `STRING_PREVIEW_CHARS` (1000, đã có ở `ide-jvm-inspect`).
- Mọi việc làm theo từng phần tử (ghi `peek`, so `equals` của E2b) phải nằm **trong thân lambda**: code ngoài lambda bị JDT thông dịch, mỗi phép là một lệnh JDI (Grounding G6).
- E3 luôn chạy khi E0 đã gửi, kể cả lúc lỗi, huỷ hay hết giờ (giữ bất biến của `run_trace`).
- Tắt mọi breakpoint dòng/hàm/dữ liệu và exception breakpoint của **phiên được trace** trước E0, khôi phục ngay sau E3 từ store (không từ adapter); id mới được ánh xạ lại; trạng thái `verified` đổi thì cập nhật và phát `BreakpointsChanged`.
- Độ trễ mục tiêu: p95 < 300 ms mỗi trace (§10.5). Hết giờ mềm `TRACE_SOFT_TIMEOUT = 30 s` thì tự chạy thang huỷ; mỗi bậc chờ `CANCEL_RUNG_WAIT = 2 s`.
- IPC: mọi lệnh trả `IdeResult<T>`, gọi `host.require_trust(window)`, đăng ký trong `ide-host` `ops::debug::register` để smoke gọi được; huỷ bằng `RequestId` + `cancel_request`; tiến độ bằng `Channel<T>`. Dòng 0-based, cột UTF-16. Sau khi đổi kiểu IPC: `pnpm gen:bindings`, commit `src/bindings.ts`.
- Frontend: tính năng không import nhau; mọi hành vi là action có id ổn định; không thêm phím mặc định (không cần dòng preset). Chuỗi hiển thị thêm vào cả `src/platform/locales/text/en.json` và `zh.json`; title action có bản zh khác en. CSS Modules + tokens (không hex), icon từ `src/ui/icons.tsx`, `aria-label` cho nút icon, `<button>` thật.
- Bundle jdtls: đổi `Bundle-Version` mỗi lần jar đổi; build bằng `python3 build.py /path/to/jdtls` (JDK 25, target 21); commit jar cùng nguồn.
- Không chép mã JetBrains; IntelliJ chỉ để tham khảo hành vi công khai.
- Commit: `feat(debugger): …` (hoặc `test(debugger): …` cho task chỉ có test), stage từng đường dẫn, không `Co-Authored-By`, không AI attribution, không stage `openspec/` hay `*.sh`.

## Grounding

Câu hỏi rủi ro nhất: _engine A có trace được một stream 10.000 phần tử trong < 300 ms trên JDK 17/21/25 mà phiên vẫn sống không?_ Trả lời: **có, nhưng chỉ khi đổi định dạng bộ ghi** (G1); định dạng của S1 mất 814–860 ms vì E2 phải xem trước từng object.

Probe (ngoài repo): `/private/tmp/claude-501/-Users-nguyenbang-code-openidea/7ba2b63d-14ee-47dc-ad14-5817bf32327c/scratchpad/s2-spike/` — bản sao bundle `jvm-inspect` (Bundle-Version 1.0.104, lệnh `streamRecording`, `streamCompact`, `spikeGetValues`, `spikeThreadOp`, `spikeTypes`), crate nháp `gen/` gọi `ide-streams` của worktree để sinh plan thật, debuggee `proj/src/demo/Main.java`, `harness.py` (LSP + DAP thật: JDT LS 1.63.0 + java-debug 0.53.2). Mọi JVM/JDT LS đã dừng theo pid (`pgrep -f 'demo.Main|equinox'` → 0).

**G1. Độ trễ trace (ms, tổng E0+E1+E2+E3; E2 trong ngoặc)**

```
                                   JDK 17      JDK 21      JDK 25
trace nhỏ 10 phần tử, định dạng S1  85–164      89–178      84–165      (E2 4–7)
trace nhỏ, định dạng gọn            72–93       72–87       84–93       (E2 1–3)
1k bản ghi, S1 + preview            128 (75)    126 (74)    130 (79)
10k bản ghi, S1 + preview           860 (815)   814 (771)   825 (776)
10k bản ghi, S1 không preview        67 (21)     65 (21)     67 (22)
1k bản ghi, gọn                      59 (4)      63 (4)      68 (5)
10k bản ghi, gọn                     71 (15)     74 (15)     79 (15)
50k bản ghi, gọn                    111 (52)    112 (47)    111 (46)
evaluate chuỗi thường (không ghi)   24
biểu thức 20 map                    121         147         106
```

Nguyên văn (JDK 17):

```
TRACE BP_BIG10K: e0 6 e1 33 e2 815 e3 6 total 862 ms entries=20002 {... 'previewUs': 794033, 'distinct': 9875}
COMPACT compact-BP_BIG50K: e0 8 e1 44 e2 52 e3 7 total 112 ms ids=50001 lines=50001 {'binVisited': 2, 'propsShape': 'chm', 'lookupUs': 1009, 'getValuesUs': 15356, 'textUs': 25548, 'textChars': 1277787}
```

Tìm `System.props` → `Properties.map` (ConcurrentHashMap) theo bin: 1–3 node, 0,6–1,8 ms.

**G2. JVM abort khi đọc mảng lớn (anti-goal "JVM của người dùng abort")**

```
JDK 17/21/25: LIMIT 100002 16384  → read 100002, 25–30 ms, alive
              LIMIT 100002 32768  → read 100002, 28–34 ms, alive
              LIMIT 65536  65536  → read 65536, 20–27 ms, alive
              LIMIT 65537  65537  → died JDWP exit error AGENT_ERROR_OUT_OF_MEMORY(188): PushLocalFrame: Unable to push JNI frame [src/jdk.jdwp.agent/share/native/libjdwp/util.c:1522/1521/1493]
```

**G3. Carry probe của S1 trên evaluator thật (17, 21, 25 cho cùng kết quả)**

```
listadd-generated   peek(sink::add), receiver generic chưa alias   ERR [java.util.List<java cannot be resolved to a type]
listadd-aliased     ((List<Integer>) __c_sink)::add                OK
listadd-lambda      x -> ((List<Integer>) __c_sink).add(x)         OK
gen-generated       ((Map<T, Integer>) __c_counts)                 ERR [T cannot be resolved to a type]
gen-bound-cast      ((java.util.Map<Comparable, Integer>) …)       OK
gen-erasure-cast    ((java.util.Map) …)                            OK
pattern-generated   rule 6 trên capture generic: ((HashMap) o)     ERR [java.util.Map<java cannot be resolved to a type]
pattern-aliased     ((HashMap) __c_o)                              OK
hoverq-simple-hint  hint "Optional<Duration>" (không import)       ERR Duration cannot be resolved to a type
hoverq-qualified    hint "Optional<java.time.Duration>"            OK
hoverv-raw-no-hint  var groups = new HashMap<…>(), alias thô        ERR The method size() is undefined for the type Object
hoverv-hint         hint "HashMap<String, List<Integer>>"          OK
hover opt           20 ms lần đầu, 3 ms sau: "Optional<Duration> opt - demo.Main.run(…)"
TYPES (JDT binding) {"qualified": "java.util.Optional<java.time.Duration>", "erasure": "java.util.Optional", "capture": false, "anonymous": false, "local": false}
                    {"qualified": "java.util.HashMap<java.lang.String,java.util.List<java.lang.Integer>>", …}
                    {"qualified": "java.util.Map<T,java.lang.Integer>", "erasure": "java.util.Map", …}
                    11–14 ms không cache, 0–14 ms qua CoreASTProvider
nestrec-generated   frame record lồng Main$Pair                    ERR Functional expressions cannot be evaluated inside local and or anonymous classes
nestrec-qualified   java.util.stream.Stream.of(a, b).map(...)       ERR (cùng thông điệp)
nested-static-class frame Main$Nested                              OK, trace 55–82 ms
inner-class         frame Main$Member                              OK, trace 58–69 ms
catch-param         x -> { try {…} catch (NumberFormatException e) {…} }   ERR Cannot find the variable e:. (2/2, có/không exception breakpoint)
local-in-block      x -> { int y = x * 2; return y + 1; }          OK
```

**G4. An toàn phiên (JDK 17/21/25 giống nhau)**

```
ticks 6268 → 7076 sau 1 s khi đang dừng ở breakpoint      (java-debug dùng SUSPEND_EVENT_THREAD: thread khác vẫn chạy)
breakpoint trong lambda của chuỗi, cùng thread           không dừng, 17 ms
exception breakpoint caught+uncaught, chuỗi chia cho 0   OK ArithmeticException@… "java.lang.ArithmeticException: / by zero", không có stopped
setBreakpoints [] rồi gửi lại                             id 1,6,3 → 7,8,9 (17) / id mới (21, 25); verified giữ nguyên; condition không được echo
evaluate 10 × 500 ms                                      OK 5014–5017 ms (không có timeout JDI)
DAP threads gửi trong lúc evaluate chạy                   không được trả lời tới khi evaluate xong (threadsLate: True)
sự kiện trong evaluate                                    hotcodereplace BUILD_COMPLETE (vô hại)
```

**G5. Thang huỷ (cả ba JDK; `oi.cx` = `RuntimeException("oi-cancel:cx")` tạo trước)**

```
nap (Thread.sleep)       interrupt → evaluate trả IllegalStateException "interrupted", phiên sống
spin (vòng lặp bận)      interrupt không tác dụng (status 1); stop(oi.cx) → RuntimeException "oi-cancel:cx", phiên sống
monitor (khoá do thread  interrupt, stop không tác dụng (status 3 = MONITOR);
  'holder' đang dừng      owners: contendedError "IncompatibleThreadStateException: Thread was not suspended",
  giữ)                    suspendedThreads [{"id": 54, "name": "holder", "suspendCount": 1, "owned": ["java.lang.Object@138"]}], 4 ms;
                          resume holder (JDI) → evaluate trả "oi-cancel:cx", phiên sống; DAP continue holder sau đó: success
lần chạy trước không resume holder: CLIENT-TIMEOUT, phiên chết
lệnh bundle trong lúc evaluate treo: trả lời trong 1–5 ms
```

**G6. Code ngoài lambda bị thông dịch; E2b `distinct` (JDK 21)**

```
vòng for ngoài lambda, 100×100 equals    OK 8121 ms
                       1000×100          OK 76171 ms
                       5000×100          CLIENT-TIMEOUT 120004 ms (đã dừng probe, kill theo pid)
cùng vòng for trong thân lambda (vị trí truyền bằng một String hằng, tách trong lambda):
  d=100  k=100   expr 1542 B    42 ms
  d=1000 k=100   expr 5142 B    36 ms
  d=5000 k=100   expr 25142 B   39 ms
  d=1000 k=1000  expr 9642 B    41 ms
  d=5000 k=5000  expr 48532 B   77 ms
kết quả String 23.892 ký tự qua DAP evaluate: không bị cắt
```

**G7. Dòng chỉ mục cho String (JDK 21)**: phần tử `"a|b\n5é😀"` ghi `0|java.lang.String|8|a|b\n5é😀\n`; bundle giải mã `coder = 1` (UTF-16LE) đúng, độ dài 8 đơn vị UTF-16 khớp; E2 6 ms cho 10 bản ghi.

## Quyết định thiết kế (rút từ Grounding)

1. **Định dạng bộ ghi gọn.** `peek` bước `k` làm, trong thân lambda: kiểm ngân sách (`__oi.size() - 2 >= budget` hoặc `__oiS.length() >= TEXT_BUDGET_CHARS` → `oi-budget`), kiểm thread (`oi-thread`), `__oi.add(x)`, rồi nối một dòng vào `__oiS`:

   ```
   dòng   := step '|' phần '\n'
   phần   := ''                                    null
           | class                                 object bất kỳ (getClass().getName(), tên nhị phân)
           | class '|' giá trị                     Integer/Long/Short/Byte/Double/Float/Boolean: String.valueOf; Character: mã int
           | 'java.lang.String' '|' len [ '|' text ]   text có mặt khi len ≤ 1000; đọc đúng len đơn vị UTF-16 (text chứa được '|', '\n')
           | class '|' len                         mảng (class bắt đầu bằng '['), len = java.lang.reflect.Array.getLength
   ```

   Sau phép kết thúc, kết quả đi qua cùng `peek` với `k = -1`: `java.util.stream.Stream.of(new Object[]{__r}).peek(<peek -1>).forEach(__oiY -> {});` (không dùng `count()`: nguồn có kích thước làm `peek` không chạy). Phép kết thúc `void` ghi `__r = null`.

2. **E2 bằng lệnh bundle `openidea.jvm.streamRecording`**: đọc `size`, `elementData`, `StringBuilder` (`count`, `coder`, `value`; JDK 8: `char[] value`, không có `coder`), phân tích dòng, lấy id phần tử theo khúc 16.384, đăng ký mọi object vào `Handles` của lần dừng hiện tại để UI mở rộng bằng `debug_jvm_memory_fields` có sẵn. Không có lệnh JDWP nào theo từng object (trừ bản ghi `-1`, xem trước đầy đủ một object).
3. **Kiểu khai báo bằng JDT binding** (`openidea.java.declaredTypes` trong `java-usages`), thay hover. Biến kiểu trong mọi kiểu dùng để cast được thay bằng erasure của bound đầu (có sẵn trong `FrameShape::type_params`), không bound thì `Object`.
4. **E2b**: chỉ khi chuỗi có `distinct` và còn phần tử bị loại không phải kiểu bọc; một `evaluate` mà toàn bộ vòng lặp nằm trong lambda; trần `DISTINCT_EQUALS_MAX = 5_000` mỗi phía mỗi bước, vượt thì bỏ qua bước đó kèm banner.
5. **Thang huỷ**: `interrupt` → chờ 2 s → `stop(list[1])` → chờ 2 s → liệt kê thread đang bị debugger dừng có giữ monitor → báo `Stuck { holders }`; UI cho người dùng chọn "Resume <thread>" (đổi trạng thái chương trình, không bao giờ tự làm) hoặc "Khởi động lại phiên".
6. **Một trace mỗi phiên tại một thời điểm** (java-debug xử lý request tuần tự): trace thứ hai trả `Busy`.

## Review Focus

1. Breakpoint biến mất hoặc nằm im sau một trace lỗi, bị huỷ, hết giờ hay phiên kết thúc giữa chừng — người dùng mong mọi breakpoint còn nguyên và vẫn dừng. Test: Task 7 `restores_breakpoints_after_failed_cancelled_and_ended_traces`.
2. Phần tử là `String` có `|`, xuống dòng, cặp surrogate, dài > 1000 ký tự, hoặc `null`, trộn với `char`/`double` — mong hiển thị đúng hoặc ghi rõ "(độ dài N)", không lệch bản ghi. Test: Task 4 `SelfTest.parsesIndexLines`, Task 1 `decodes_mixed_values`.
3. Stream lớn hơn ngân sách (ví dụ `IntStream.range(0, 1_000_000)`) — mong banner "vượt ngân sách" với các bản ghi đã có, không treo, không abort JVM; không lần đọc nào > 16.384 phần tử. Test: Task 4 `SelfTest.chunksNeverExceedLimit`, Task 10 ca `c27`.
4. Người dùng bấm Stop/Restart phiên, hoặc chương trình thoát, khi trace đang chạy — mong lệnh trả về ngay với `SessionEnded`, hộp thoại đóng gọn. Test: Task 7 `session_end_during_e1_returns_ended`.
5. Bấm trace hai lần liên tiếp hoặc step/resume khi hộp thoại đang mở — mong lần hai bị từ chối `Busy`, kết quả cũ hiện "đã cũ" sau khi phiên chạy tiếp. Test: Task 7 `second_trace_is_busy`, Task 9 `marks_trace_stale_after_resume`.

---

## Bản đồ file

| File                                                                                                                                                                                                                                | Trách nhiệm                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `crates/ide-streams/src/generate.rs`                                                                                                                                                                                                | sinh E0/E1/E3 theo định dạng gọn, hằng ngân sách           |
| `crates/ide-streams/src/decode.rs`                                                                                                                                                                                                  | `Recording` theo bản ghi, `Outcome::Cancelled`, banner mới |
| `crates/ide-streams/src/equals_pass.rs` (mới)                                                                                                                                                                                       | sinh và áp E2b                                             |
| `crates/ide-streams/src/trace.rs`                                                                                                                                                                                                   | `run_trace` thêm E2b, `TraceTimings`                       |
| `crates/ide-streams/src/facts/{captures,generic,pattern}.rs`, `chain/{mod,frame}.rs`, `facts/rules.rs`, `normalize.rs`                                                                                                              | các carry của S1                                           |
| `java/jvm-inspect/src/ai/openidea/jvminspect/{StreamRecording,ThreadControl,PropsLookup}.java` (mới), `InspectCommand.java`, `plugin.xml`, `MANIFEST.MF`, `README.md`, `tests/SelfTest.java`, `tests/inspect.py`                    | E2 và điều khiển thread                                    |
| `java/java-usages/src/ai/openidea/types/DeclaredTypesCommand.java` (mới), `plugin.xml`, `MANIFEST.MF`, `tests/declared_types.py` (mới)                                                                                              | kiểu khai báo                                              |
| `crates/ide-jvm-inspect/src/stream.rs` (mới)                                                                                                                                                                                        | trait `StreamProbe` và kiểu                                |
| `crates/ide-lsp/src/jdtls/stream_probe.rs` (mới), `crates/ide-lsp/src/jdtls/declared_types.rs` (mới)                                                                                                                                | client hai bundle                                          |
| `crates/ide-dap/src/stream_trace/{mod,mute,cancel,adapters}.rs` (mới), `lib.rs`, `session.rs`                                                                                                                                       | điều phối trace                                            |
| `crates/ide-host/src/ops/debug/streams.rs` (mới), `ops/debug.rs`                                                                                                                                                                    | tìm chuỗi, plan, IPC                                       |
| `src-tauri/src/commands/debug.rs`, `commands/mod.rs`, `src/bindings.ts`                                                                                                                                                             | lệnh Tauri                                                 |
| `src/features/debugger/streams/{streamsState.ts,StreamTraceDialog.tsx,StreamTraceDialog.module.css,StepColumns.tsx,links.ts}` (mới), `actions.ts`, `state.ts`, `ui/popoverStore.ts`, `ui/Overlays.tsx`, `src/ui/icons.tsx`, locales | UI                                                         |
| `fixtures/java-streams/` (mới), `smoke/streams.test.ts` (mới)                                                                                                                                                                       | bộ ~30 chuỗi                                               |

---

### Task 1: Bộ ghi gọn, `Outcome::Cancelled`, giải mã theo bản ghi

**Files:**

- Modify: `crates/ide-streams/src/generate.rs`, `crates/ide-streams/src/decode.rs`, `crates/ide-streams/src/trace.rs:80-130`
- Test: các module `#[cfg(test)]` trong cùng file, snapshot biểu thức hiện có của S1 (cập nhật)

**Interfaces:**

- Produces:
  - `pub const DEFAULT_BUDGET_RECORDS: usize = 50_000;` (xoá `DEFAULT_BUDGET_ENTRIES`), `pub const TEXT_BUDGET_CHARS: usize = 2_000_000;`, `pub const RECORDER_HEADER: usize = 2;`, `pub const STRING_INLINE_CHARS: usize = 1000;`
  - `TracePlan.budget` nay đếm bản ghi; `build_plan(chain: &NormalizedChain, nonce: &str, budget: usize) -> TracePlan` giữ chữ ký.
  - `pub struct RawRecord { pub step: i32, pub value: TraceValue }`
  - `pub struct Recording { pub records: Vec<RawRecord>, pub total: usize }` (`total`: số bản ghi thật trong debuggee, gồm bản ghi `-1`)
  - `Outcome::Cancelled` (thêm), `Banner::DistinctByEquals { step: u16 }`, `Banner::DistinctUnresolved { step: u16, count: u32 }` (dùng ở Task 3)
  - `decode(plan, &Recording, &E1Value) -> Result<DecodedTrace, DecodeError>` giữ chữ ký.

- [ ] **Step 1: Viết test hỏng**

```rust
#[test]
fn e0_installs_header_and_cancel_throwable() {
    let p = build_plan(&sample_chain(), "n1", 7);
    assert_eq!(p.e0, "java.util.ArrayList __l = new java.util.ArrayList(); __l.add(new StringBuilder()); \
        __l.add(new RuntimeException(\"oi-cancel:n1\")); Object __r = System.getProperties().put(\"oi.n1\", __l); return __r;");
}

#[test]
fn peek_writes_index_line_inside_lambda() {
    let p = build_plan(&sample_chain(), "n1", 7);
    assert!(p.e1.contains("if (__oi.size() - 2 >= 7 || __oiS.length() >= 2000000) throw new IllegalStateException(\"oi-budget:n1\");"));
    assert!(p.e1.contains("__oiS.append(0).append('|')"));
    assert!(p.e1.contains("java.util.stream.Stream.of(new Object[]{__r}).peek("));
    assert!(!p.e1.contains(".count(); __oi")); // kết quả không đi qua count()
}

#[test]
fn decodes_mixed_values() {
    // bản ghi: bước 0 null, char 'x' (120), double 1.5, String dài 1200 (không có text), mảng int[3]; rồi -1 Long 5
    let rec = Recording { records: vec![
        raw(0, TraceValue::Null), raw(0, boxed(BoxKind::Char, "x")), raw(0, boxed(BoxKind::Double, "1.5")),
        raw(0, TraceValue::Str { id: 9, value: String::new(), truncated: true }),
        raw(0, TraceValue::Object { id: 10, class: "[I".into() }), raw(-1, boxed(BoxKind::Long, "5")),
    ], total: 6 };
    let t = decode(&plan_with_steps(1), &rec, &e1("Long", "5")).unwrap();
    assert_eq!(t.records.len(), 5);
    assert_eq!(t.outcome, Outcome::Completed { result: Some(boxed(BoxKind::Long, "5")) });
}

#[test]
fn cancel_message_gives_cancelled_outcome() {
    let rec = Recording { records: vec![raw(0, int(1))], total: 1 };
    let t = decode(&plan_with_nonce("n1"), &rec, &e1("RuntimeException", "java.lang.RuntimeException: oi-cancel:n1")).unwrap();
    assert_eq!(t.outcome, Outcome::Cancelled);
}

#[test]
fn truncated_read_keeps_banner() {
    let rec = Recording { records: vec![raw(0, int(1)), raw(1, int(1))], total: 50_000 };
    let t = decode(&plan_with_steps(1), &rec, &e1("ArrayList", "ArrayList@1 size=1")).unwrap();
    assert!(t.banners.contains(&Banner::Truncated { read: 2, total: 50_000 }));
}
```

Các test S1 hiện có cho `oi-budget`, `oi-thread`, `CountFromSize`, `SortedPassThrough`, ngoại lệ giữa chừng (không có `-1`) chuyển sang `Recording` mới, giữ nguyên kỳ vọng.

- [ ] **Step 2: Chạy, xác nhận hỏng**

Run: `cargo nextest run -p ide-streams`
Expected: FAIL (không có `RawRecord`, `Outcome::Cancelled`, E0 cũ).

- [ ] **Step 3: Cài đặt**

`generate.rs`: E0 như test; `peek(k)` sinh thân lambda theo ngữ pháp dòng ở "Quyết định thiết kế" 1 (biến `__oiS` lấy ở đầu E1: `StringBuilder __oiS = (StringBuilder) __oi.get(0);`). `decode.rs`: duyệt `records`; bản ghi `step == -1` là dấu kết thúc; `Truncated` khi `records.len() < total`; `Cancelled` khi E1 là giá trị ngoại lệ có `oi-cancel:<nonce>` và không có dấu kết thúc. `trace.rs`: `reader.read(&plan.key, plan.budget + 1)`.

- [ ] **Step 4: Chạy, xác nhận qua**

Run: `cargo nextest run -p ide-streams`
Expected: PASS, gồm property test resolver của S1 (không đổi).

- [ ] **Step 5: Commit**

```bash
git add crates/ide-streams/src/generate.rs crates/ide-streams/src/decode.rs crates/ide-streams/src/trace.rs crates/ide-streams/tests
git commit -m "feat(debugger): record stream traces as an index line per element"
```

### Task 2: Các carry của S1 lên evaluator thật

**Files:**

- Modify: `crates/ide-streams/src/facts/captures.rs`, `facts/generic.rs`, `facts/pattern.rs`, `facts/rules.rs`, `chain/mod.rs:90-140`, `chain/frame.rs`, `normalize.rs:45-120`
- Test: test trong các module trên; fixture Java của S1 `crates/ide-streams/tests/fixtures/` thêm ca

**Interfaces:**

- Consumes: `FrameShape::type_params: Vec<(String, Option<String>)>` (S1).
- Produces:
  - `FrameKind::NestedRecord` (thêm), `Rejection::CatchInLambda` (thêm).
  - `pub struct DeclaredType { pub qualified: String, pub erasure: String, pub capture: bool, pub anonymous: bool, pub local: bool }` trong `normalize.rs`.
  - `pub fn hints_from_declared(queries: &[TypeQuery], answers: &[Option<DeclaredType>]) -> Result<TypeHints, Rejection>` — `anonymous || local` → `Rejection::UnqualifiableType { name }`; `capture` → không có hint (đi đường `CaptureRaw` dùng `erasure`); còn lại hint = `qualified`.
  - `pub fn erase_type_vars(ty: &str, type_params: &[(String, Option<String>)]) -> String` (thay mỗi biến kiểu bằng bound hoặc `Object`, chỉ ở vị trí tên kiểu).

- [ ] **Step 1: Viết test hỏng**

```rust
#[test]
fn method_ref_receiver_of_generic_capture_is_aliased() {
    let n = normalize_at("BP_LISTADD"); // xs.stream().filter(x -> x > 0).peek(sink::add).count(), List<Integer> sink
    assert!(n.text().contains("peek(((List<Integer>) __c_sink)::add)"));
}

#[test]
fn cast_type_variables_become_their_bound() {
    assert_eq!(erase_type_vars("Map<T, Integer>", &[("T".into(), Some("Comparable".into()))]), "Map<Comparable, Integer>");
    assert_eq!(erase_type_vars("java.util.Map<T,java.lang.Integer>", &[("T".into(), None)]), "java.util.Map<Object,java.lang.Integer>");
    assert_eq!(erase_type_vars("List<Tx>", &[("T".into(), None)]), "List<Tx>");
}

#[test]
fn pattern_rewrite_reads_the_alias() {
    let n = normalize_at("BP_PATTERN"); // o instanceof HashMap h ? h.size() + x : x, Map<String,Integer> o
    assert!(n.text().contains("((HashMap) __c_o)"));
    assert!(!n.text().contains("((HashMap) o)"));
}

#[test]
fn nested_record_frame_is_rejected() {
    assert_eq!(reject_at("BP_NESTREC"), Rejection::UnsupportedFrame { frame: FrameKind::NestedRecord });
}

#[test]
fn catch_parameter_in_block_lambda_is_rejected() {
    assert_eq!(reject_at("BP_CATCH"), Rejection::CatchInLambda); // map(x -> { try {…} catch (NumberFormatException e) {…} })
}

#[test]
fn declared_type_answers_become_hints() {
    let q = [query(0, "opt"), query(1, "anon"), query(2, "w")];
    let a = [Some(dt("java.util.Optional<java.time.Duration>", "java.util.Optional")),
             None, Some(DeclaredType { capture: true, ..dt("capture#1-of ?", "java.util.List") })];
    let hints = hints_from_declared(&q, &a).unwrap();
    assert_eq!(hints.0.get(&0).map(String::as_str), Some("java.util.Optional<java.time.Duration>"));
    assert!(hints.0.get(&2).is_none());
    let a2 = [Some(DeclaredType { anonymous: true, ..dt("", "java.lang.Object") }), None, None];
    assert!(matches!(hints_from_declared(&q, &a2), Err(Rejection::UnqualifiableType { .. })));
}
```

Static nested class và inner class không bị từ chối (G3: trace OK) — thêm hai ca `BP_NESTED`, `BP_INNERCLS` vào test frame hiện có, kỳ vọng `Ok`.

- [ ] **Step 2: Chạy, xác nhận hỏng** — `cargo nextest run -p ide-streams`, FAIL ở 6 test trên.

- [ ] **Step 3: Cài đặt** — alias receiver của method ref dùng cùng `Capture::uses` (thêm vị trí receiver của `name::m` vào `uses`); cast alias và `GenericCast` đi qua `erase_type_vars`; rule 6 thay `uses` trước rồi mới rewrite pattern; `frame.rs` phát hiện record không phải top-level (record lồng trong class/interface, kể cả `static`) → `NestedRecord`; `rules.rs` thêm blocker khi thân lambda khối trong chuỗi có `catch_clause`.

- [ ] **Step 4: Chạy, xác nhận qua** — `cargo nextest run -p ide-streams`, PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ide-streams/src crates/ide-streams/tests
git commit -m "feat(debugger): fix stream normalisation cases the JDT evaluator rejects"
```

### Task 3: Pha E2b — `distinct` theo `equals`

**Files:**

- Create: `crates/ide-streams/src/equals_pass.rs`
- Modify: `crates/ide-streams/src/lib.rs`, `crates/ide-streams/src/trace.rs`
- Test: `equals_pass.rs` `#[cfg(test)]`, `trace.rs` test với evaluator giả

**Interfaces:**

- Consumes: `distinct_drops(records, links, step) -> Vec<DistinctDrop>` (S1), `RECORDER_HEADER` (Task 1).
- Produces:
  - `pub const DISTINCT_EQUALS_MAX: usize = 5_000;`
  - `pub struct EqualsPass { pub expression: String, steps: Vec<EqualsStep> }` với `EqualsStep { step: u16, dropped: Vec<u32>, kept: Vec<u32> }` (chỉ số bản ghi)
  - `pub fn equals_pass(plan: &TracePlan, trace: &DecodedTrace, drops: &[DistinctDrop]) -> (Option<EqualsPass>, Vec<Banner>)` — chỉ lấy drop có `same_as == None` và giá trị không phải `Boxed`/`Null`; bước nào vượt trần thì không đưa vào và thêm `DistinctUnresolved`.
  - `impl EqualsPass { pub fn apply(&self, result_text: &str, drops: &mut [DistinctDrop]) -> Result<Vec<Banner>, DecodeError> }` — điền `same_as`, trả `DistinctByEquals { step }` cho mỗi bước đã chạy.
  - `TraceResult` thêm `timings: TraceTimings { e0_ms: u32, e1_ms: u32, e2_ms: u32, e2b_ms: Option<u32>, e3_ms: u32, total_ms: u32 }`.

- [ ] **Step 1: Viết test hỏng**

```rust
#[test]
fn expression_keeps_the_loop_inside_a_lambda() {
    let (pass, banners) = equals_pass(&plan("n1"), &trace_with_object_drops(3, 2), &drops_unresolved(3));
    let e = pass.unwrap().expression;
    assert!(e.starts_with("java.util.ArrayList __oi = (java.util.ArrayList) System.getProperties().get(\"oi.n1\"); Object __r = java.util.stream.Stream.of(\""));
    assert!(e.contains(".map(__p -> {"));
    assert!(e.contains("java.util.Objects.equals("));
    assert!(e.ends_with(").findFirst().get(); return __r;"));
    assert!(banners.is_empty());
}

#[test]
fn positions_are_list_indices_after_the_header() {
    let (pass, _) = equals_pass(&plan("n1"), &trace_with_object_drops(1, 1), &[drop(4, None)]);
    assert!(pass.unwrap().expression.contains("\"6;")); // bản ghi 4 → list[6]
}

#[test]
fn boxed_drops_and_oversized_steps_are_skipped() {
    let (pass, banners) = equals_pass(&plan("n1"), &trace_with_object_drops(5_001, 1), &drops_unresolved(5_001));
    assert!(pass.is_none());
    assert_eq!(banners, vec![Banner::DistinctUnresolved { step: 2, count: 5_001 }]);
}

#[test]
fn apply_fills_same_as() {
    let (pass, _) = equals_pass(&plan("n1"), &trace_with_object_drops(2, 2), &drops_unresolved(2));
    let mut d = drops_unresolved(2);
    let banners = pass.unwrap().apply("\"5,-1,\"", &mut d).unwrap();
    assert_eq!(d[0].same_as, Some(3)); // list[5] → bản ghi 3
    assert_eq!(d[1].same_as, None);
    assert_eq!(banners, vec![Banner::DistinctByEquals { step: 2 }]);
}

#[tokio::test]
async fn run_trace_runs_e2b_between_read_and_e3() {
    let eval = ScriptedEvaluator::new(); // ghi lại thứ tự biểu thức
    run_trace(&distinct_plan(), &eval, &reader_with_object_drops(), &CancellationToken::new()).await.unwrap();
    assert_eq!(eval.kinds(), ["e0", "e1", "e2b", "e3"]);
}
```

- [ ] **Step 2: Chạy, xác nhận hỏng** — `cargo nextest run -p ide-streams`, FAIL.

- [ ] **Step 3: Cài đặt** — chuỗi hằng `"<dropped,…>;<kept,…>|<dropped…>;<kept…>"` một nhóm mỗi bước; thân lambda tách, so `equals` từng dropped với kept theo thứ tự, nối `m,` (m = chỉ số list hoặc `-1`), giữa các bước dùng `|`. E2b lỗi (`Err` từ evaluator) thì không làm hỏng trace: drop giữ `None`, thêm `DistinctUnresolved`. Đo thời gian từng pha bằng `Instant` (không cần đồng hồ giả).

- [ ] **Step 4: Chạy, xác nhận qua** — `cargo nextest run -p ide-streams`, PASS.

- [ ] **Step 5: Bench vào ngân sách perf (§14)** — `crates/ide-streams/benches/trace.rs` (criterion, theo mẫu bench hiện có của `pnpm perf:rust`): `decode_and_resolve_50k` (50.000 bản ghi, 3 bước, có `sorted` và `distinct`) và `equals_pass_5k`; chạy một lần, đặt ngân sách trong `perf/budgets.json` = 2 × số đo. Run: `pnpm perf:rust` → PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ide-streams/src/equals_pass.rs crates/ide-streams/src/lib.rs crates/ide-streams/src/trace.rs crates/ide-streams/benches/trace.rs crates/ide-streams/Cargo.toml perf/budgets.json
git commit -m "feat(debugger): link distinct's dropped elements with one equals pass"
```

### Task 4: Bundle `jvm-inspect` — đọc bản ghi và điều khiển thread

**Files:**

- Create: `java/jvm-inspect/src/ai/openidea/jvminspect/PropsLookup.java`, `StreamRecording.java`, `ThreadControl.java`
- Modify: `InspectCommand.java`, `plugin.xml`, `MANIFEST.MF` (`Bundle-Version: 1.1.0`), `README.md` (mục Commands), `openidea-jvm-inspect.jar`
- Test: `java/jvm-inspect/tests/SelfTest.java`, `java/jvm-inspect/tests/inspect.py` (thêm kịch bản `--stream`)

**Interfaces:**

- Produces (JSON qua `workspace/executeCommand`, cùng đường lỗi `{"error": code, "detail"}`):
  - `openidea.jvm.streamRecording(target, key: String, limit: int)` → `{"ok": {"records": [{"step": int, "value": <JvmValue JSON>}], "total": int}}`; mã lỗi `notFound` khi không có khoá, `malformed` khi số dòng ≠ `size - 2`.
  - `openidea.jvm.threadControl(target, threadId: long, op: "interrupt"|"stop"|"resume"|"owners", key: String|null)` → `{"ok": {"status": int, "suspendCount": int, "owners": [{"id": long, "name": String, "monitors": int}]?}}`. Lệnh này **không** kiểm `notSuspended` và không đi qua `Handles.begin`.
  - `JvmValue` JSON giống `Values` hiện có: `str` có `text` khi `length ≤ 1000`; `boxed` có `typeName` `java.lang.Integer`…, `text`; `array` có `length`; `object` có `typeName`.

- [ ] **Step 1: Viết test hỏng (SelfTest, không cần JVM)**

```java
static void parsesIndexLines() {
    String text = "0|\n0|java.lang.Character|120\n0|java.lang.Double|1.5\n"
        + "0|java.lang.String|8|a|b\n5é😀\n0|java.lang.String|1200\n0|[I|3\n-1|java.lang.Long|5\n";
    List<StreamRecording.Line> lines = StreamRecording.parse(text, 100);
    check(lines.size() == 7, "7 lines");
    check(lines.get(3).text().equals("a|b\n5é😀"), "string with separators");
    check(lines.get(4).text() == null && lines.get(4).length() == 1200, "long string has length only");
    check(lines.get(5).arrayLength() == 3, "array length");
    check(lines.get(6).step() == -1, "terminator");
}

static void chunksNeverExceedLimit() {
    List<int[]> calls = StreamRecording.chunks(2, 100_001);   // [start, count]
    check(calls.stream().allMatch(c -> c[1] <= 16_384), "chunk ≤ 16384");
    check(calls.stream().mapToInt(c -> c[1]).sum() == 100_001, "covers all");
}

static void chmIndexMatchesConcurrentHashMap() {
    for (String k : List.of("oi.a", "oi.zz9", "java.home"))
        check(PropsLookup.binIndex(k, 64) == ((64 - 1) & ((k.hashCode() ^ (k.hashCode() >>> 16)) & 0x7fffffff)), k);
}
```

`tests/inspect.py --stream` (JDT LS thật): debuggee dừng ở breakpoint, `evaluate` E0/E1 do `ide-streams` sinh (chép từ snapshot của Task 1) cho 10, 25.000 và 50.000 phần tử; gọi `streamRecording`; kỳ vọng `total` đúng, `records[0].step == 0`, phiên còn sống (`evaluate "1 + 1"` → `2`); `threadControl owners` khi không có thread nào giữ monitor → `owners: []`.

- [ ] **Step 2: Chạy, xác nhận hỏng**

Run: `python3 build.py /path/to/jdtls --test`
Expected: FAIL (lớp `StreamRecording` chưa có).

- [ ] **Step 3: Cài đặt** — `PropsLookup.find(vm, key)`: `System.props` → field `map` (ConcurrentHashMap; theo `TreeBin.first`, `ForwardingNode.nextTable`), không có `map` thì đi `Hashtable.table` (JDK 8). `StreamRecording.read`: `elementData.getValues` theo `chunks`, text của `StringBuilder` đọc `value` theo khúc 1.048.576, `coder == 1` → UTF-16LE; parse; bỏ cặp surrogate lẻ ở cuối text; mỗi `ObjectReference` → `handles.put(uniqueID, ref)`; bản ghi `-1` dùng `Values.preview`. `ThreadControl`: `interrupt` → `ThreadReference.interrupt()`; `stop` → `stop(list[1])` lấy bằng `PropsLookup`; `resume` → `resume()` khi `suspendCount > 0`; `owners` → mọi thread khác `threadId` đang `isSuspended()` có `ownedMonitors()` khác rỗng (lỗi `ownedMonitors` thì `monitors = -1`). Đổi `Bundle-Version`, build jar.

- [ ] **Step 4: Chạy, xác nhận qua**

Run: `python3 build.py /path/to/jdtls --test` rồi `python3 -I tests/inspect.py /path/to/jdtls /path/to/com.microsoft.java.debug.plugin-0.53.2.jar --stream`
Expected: `SelfTest: all checks passed`; `inspect.py`: ba cỡ đọc đúng, E2 50k < 100 ms, `alive`.

- [ ] **Step 5: Commit**

```bash
git add java/jvm-inspect/src java/jvm-inspect/tests java/jvm-inspect/plugin.xml java/jvm-inspect/MANIFEST.MF java/jvm-inspect/README.md java/jvm-inspect/openidea-jvm-inspect.jar
git commit -m "feat(debugger): read stream recordings and control the tracing thread in jvm-inspect"
```

### Task 5: Bundle `java-usages` — `openidea.java.declaredTypes`

**Files:**

- Create: `java/java-usages/src/ai/openidea/types/DeclaredTypesCommand.java`, `java/java-usages/tests/declared_types.py`
- Modify: `java/java-usages/plugin.xml` (`<command id="openidea.java.declaredTypes"/>`), `MANIFEST.MF` (`Bundle-Version: 1.8.0`), `README.md`, `openidea-java-usages.jar`

**Interfaces:**

- Produces: `openidea.java.declaredTypes(uri: String, positions: [[line, utf16Col], …])` → `[{"qualified", "erasure", "capture": bool, "anonymous": bool, "local": bool} | null, …]` song song với `positions`; vị trí trỏ vào tên biến tại khai báo; `null` khi không tìm được binding biến.

- [ ] **Step 1: Viết test hỏng** — `tests/declared_types.py` mở `fixtures/java-streams` (Task 10 tạo; trước đó dùng file tạm trong test) với JDT LS thật, hỏi ba biến `var opt = Optional.of(Duration.ofSeconds(1))`, `var groups = new HashMap<String, List<Integer>>()`, tham số `Map<T, Integer> counts`; kỳ vọng đúng ba chuỗi `qualified` như G3 và lần gọi thứ hai < 20 ms.
- [ ] **Step 2: Chạy, xác nhận hỏng** — `python3 -I tests/declared_types.py /path/to/jdtls` → FAIL "unknown command".
- [ ] **Step 3: Cài đặt** — `JDTUtils.resolveCompilationUnit(uri)`, `CoreASTProvider.getInstance().getAST(cu, WAIT_YES, monitor)` (cache), `NodeFinder` tại offset (`JsonRpcHelpers.toOffset`), `SimpleName.resolveBinding()` là `IVariableBinding` → `getType()`; `qualified = getQualifiedName()`, `erasure = getErasure().getQualifiedName()`, cờ `isCapture()`, `isAnonymous()`, `isLocal()`.
- [ ] **Step 4: Chạy, xác nhận qua** — `python3 build.py /path/to/jdtls` rồi `python3 -I tests/declared_types.py /path/to/jdtls` → PASS.
- [ ] **Step 5: Commit**

```bash
git add java/java-usages/src/ai/openidea/types java/java-usages/tests/declared_types.py java/java-usages/plugin.xml java/java-usages/MANIFEST.MF java/java-usages/README.md java/java-usages/openidea-java-usages.jar
git commit -m "feat(debugger): resolve declared Java types for stream tracing in java-usages"
```

### Task 6: `StreamProbe` và client jdtls

**Files:**

- Create: `crates/ide-jvm-inspect/src/stream.rs`, `crates/ide-lsp/src/jdtls/stream_probe.rs`, `crates/ide-lsp/src/jdtls/declared_types.rs`
- Modify: `crates/ide-jvm-inspect/src/lib.rs`, `crates/ide-lsp/src/jdtls.rs` (mod), `crates/ide-lsp/src/lib.rs` (pub use)

**Interfaces:**

- Produces (`ide-jvm-inspect`):

```rust
pub const STREAM_READ_CHUNK: u32 = 16_384;
pub struct StreamRecord { pub step: i32, pub value: JvmValue }
pub struct StreamRecording { pub records: Vec<StreamRecord>, pub total: usize }
pub enum ThreadOp { Interrupt, Stop { key: String }, Resume }
pub struct ThreadState { pub status: i32, pub suspend_count: i32 }
pub struct MonitorHolder { pub thread_id: i64, pub name: String, pub monitors: i32 }
pub trait StreamProbe: Send + Sync {
    fn recording<'a>(&'a self, target: &'a VmTarget, key: &'a str, limit: usize) -> InspectFuture<'a, StreamRecording>;
    fn thread<'a>(&'a self, target: &'a VmTarget, thread_id: i64, op: ThreadOp) -> InspectFuture<'a, ThreadState>;
    fn monitor_holders<'a>(&'a self, target: &'a VmTarget, except: i64) -> InspectFuture<'a, Vec<MonitorHolder>>;
}
```

- Produces (`ide-lsp`): `pub struct JdtStreamProbe` (`new(lsp: Arc<LspManager>, server: PathBuf)`), `impl StreamProbe`; `thread`/`monitor_holders` **không** lấy mutex `turn` của `JdtJvmInspector` (chúng chạy khi E1 đang treo). `impl LspManager { pub async fn java_declared_types(&self, path: &Path, positions: &[Pos]) -> IdeResult<Vec<Option<ide_streams::DeclaredType>>> }` (thêm `ide-streams` vào `ide-lsp/Cargo.toml`). Timeout: recording 30 s, thread 10 s, declared types 15 s.

- [ ] **Step 1: Viết test hỏng** — trong `stream_probe.rs`, test giải mã JSON trả về (không cần jdtls), theo mẫu test `decode` của `jvm_inspect.rs`:

```rust
#[test]
fn decodes_recording_reply() {
    let v = json!({"ok": {"records": [{"step": 0, "value": {"kind": "string", "id": 7, "text": "a|b", "length": 3}},
                                     {"step": -1, "value": {"kind": "null"}}], "total": 2}});
    let r: StreamRecording = decode(v).unwrap();
    assert_eq!(r.total, 2);
    assert_eq!(r.records[0].value, JvmValue::Str { id: 7, text: Some("a|b".into()), length: 3 });
}

#[test]
fn not_found_maps_to_failed_detail() {
    assert!(matches!(decode::<StreamRecording>(json!({"error": "notFound", "detail": "x"})), Err(InspectError::Failed(_))));
}
```

- [ ] **Step 2: Chạy, xác nhận hỏng** — `cargo nextest run -p ide-lsp stream_probe`, FAIL.
- [ ] **Step 3: Cài đặt** — gọi `LspManager::jdtls_command(server, "openidea.jvm.streamRecording", args)` với target JSON như `JdtJvmInspector::call`; ánh xạ mã lỗi giống `jvm_inspect.rs::decode` (`notFound` → `Failed("notFound")` để `ide-dap` đổi thành `ReadError::NotFound`).
- [ ] **Step 4: Chạy, xác nhận qua** — `cargo nextest run -p ide-lsp -p ide-jvm-inspect`, PASS.
- [ ] **Step 5: Commit**

```bash
git add crates/ide-jvm-inspect/src crates/ide-lsp/src/jdtls/stream_probe.rs crates/ide-lsp/src/jdtls/declared_types.rs crates/ide-lsp/src/jdtls.rs crates/ide-lsp/src/lib.rs crates/ide-lsp/Cargo.toml Cargo.lock
git commit -m "feat(debugger): add the jdtls stream probe client"
```

### Task 7: Điều phối trace trong `ide-dap`

**Files:**

- Create: `crates/ide-dap/src/stream_trace/mod.rs`, `mute.rs`, `cancel.rs`, `adapters.rs`, `tests.rs`
- Modify: `crates/ide-dap/src/lib.rs` (mod, `DebugCapabilities.stream_trace`, `capabilities()`, `set_stream_probe`), `crates/ide-dap/src/session.rs` (`stream_probe: Mutex<Option<Arc<dyn StreamProbe>>>`, `stream_busy: AtomicBool`), `crates/ide-dap/Cargo.toml` (`ide-streams`)

**Interfaces:**

- Consumes: `run_trace`, `TracePlan`, `TraceResult`, `TraceError`, `equals_pass` (Task 1–3); `StreamProbe` (Task 6); `suspend_breakpoints`, `restore_breakpoints`, `send_exception_breakpoints`, `vm_target` (có sẵn).
- Produces:

```rust
pub struct DebugCapabilities { …, pub stream_trace: bool }
impl DebugManager {
    pub fn set_stream_probe(&self, s: DebugSessionId, probe: Arc<dyn StreamProbe>) -> IdeResult<()>; // phát DebugEvent::Capabilities
    pub async fn stream_trace(&self, s: DebugSessionId, thread_id: i64, frame_id: i64, plan: TracePlan,
        cancel: CancellationToken, progress: impl Fn(StreamTraceProgress) + Send + Sync) -> IdeResult<StreamTraceRun>;
    pub async fn stream_resume_holder(&self, s: DebugSessionId, thread_id: i64) -> IdeResult<()>;
}
pub enum StreamTraceRun { Done { result: TraceResult, generation: u64 }, Failed { error: TraceError }, Unavailable { reason: StreamUnavailable } }
pub enum StreamUnavailable { NotJavaDebug, NoProbe, NotPaused, Busy, SessionEnded, NotJavaFrame }
pub enum StreamTraceProgress { Evaluating, Cancelling { rung: CancelRung }, Stuck { holders: Vec<MonitorHolder> } }
pub enum CancelRung { Interrupt, Stop }
```

(mọi enum `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]`, `Type`; `MonitorHolder` thêm derive `Serialize, Deserialize, Type` ở Task 6.)

- [ ] **Step 1: Viết test hỏng** — `stream_trace/tests.rs` với `FakeLauncher` có sẵn của `ide-dap` (script DAP) và `FakeProbe`:

```rust
#[tokio::test]
async fn restores_breakpoints_after_failed_cancelled_and_ended_traces() {
    for ending in [Ending::E1Error, Ending::Cancelled, Ending::SessionEnded] {
        let h = Harness::paused_java_with_breakpoints(&[("A.java", &[3, 9]), ("B.java", &[1])], &["caught"]).await;
        let _ = h.trace(ending).await;
        let sent = h.adapter.requests("setBreakpoints");
        assert_eq!(sent.first_for("A.java").lines(), Vec::<u32>::new(), "{ending:?}: muted");
        if ending != Ending::SessionEnded {
            assert_eq!(sent.last_for("A.java").lines(), vec![4, 10], "{ending:?}: restored");
            assert_eq!(h.adapter.last("setExceptionBreakpoints")["filters"], json!(["caught"]));
            assert_eq!(h.manager.breakpoint_states(&h.path("A.java")).len(), 2);
        }
    }
}

#[tokio::test]
async fn evaluates_e0_e1_reads_then_e3_on_the_stopped_frame() {
    let h = Harness::paused_java().await;
    let run = h.trace(Ending::Completes).await.unwrap();
    assert!(matches!(run, StreamTraceRun::Done { .. }));
    assert_eq!(h.adapter.evaluated_kinds(), ["e0", "e1", "e3"]);
    assert!(h.adapter.requests("evaluate").iter().all(|r| r["frameId"] == json!(h.frame_id)));
}

#[tokio::test]
async fn cancel_ladder_interrupts_then_stops_then_reports_holders() {
    let h = Harness::paused_java().await.e1_never_returns().holders(vec![holder(54, "holder")]);
    let (run, progress) = h.trace_cancelled_after(Duration::from_millis(10)).await;
    assert_eq!(h.probe.ops(), [ThreadOp::Interrupt, ThreadOp::Stop { key: h.plan.key.clone() }]);
    assert_eq!(progress.last(), Some(&StreamTraceProgress::Stuck { holders: vec![holder(54, "holder")] }));
    h.manager.stream_resume_holder(h.id, 54).await.unwrap();
    assert_eq!(h.probe.ops().last(), Some(&ThreadOp::Resume));
    h.adapter.release_e1_with("java.lang.RuntimeException: oi-cancel:n1");
    assert!(matches!(run.await.unwrap(), StreamTraceRun::Done { result, .. } if result.trace.outcome == Outcome::Cancelled));
}

#[tokio::test]
async fn second_trace_is_busy() {
    let h = Harness::paused_java().await.e1_never_returns();
    let first = h.trace_in_background();
    assert!(matches!(h.trace(Ending::Completes).await.unwrap(), StreamTraceRun::Unavailable { reason: StreamUnavailable::Busy }));
    first.abort();
}

#[tokio::test]
async fn session_end_during_e1_returns_ended() {
    let h = Harness::paused_java().await.e1_never_returns();
    let run = h.trace_in_background();
    h.adapter.terminate();
    assert!(matches!(run.await.unwrap().unwrap(), StreamTraceRun::Unavailable { reason: StreamUnavailable::SessionEnded }));
}

#[test]
fn stream_trace_capability_only_for_java_debug_with_probe() {
    assert!(caps_for("java-debug", true).stream_trace);
    for (adapter, probe) in [("java-debug", false), ("kotlin-lsp", true), ("kotlin-debug-adapter", true), ("debugpy", true)] {
        assert!(!caps_for(adapter, probe).stream_trace, "{adapter}");
    }
}
```

- [ ] **Step 2: Chạy, xác nhận hỏng** — `cargo nextest run -p ide-dap stream_trace`, FAIL.
- [ ] **Step 3: Cài đặt**
  - `adapters.rs`: `DapEvaluator` (`evaluate` với `frameId`, context `"repl"`; E0/E3/E2b dùng `REQUEST_TIMEOUT`; E1 không có timeout riêng, kết thúc bởi `select!` giữa phản hồi, `session.ended` và đồng hồ của thang huỷ); `ProbeReader` đổi `StreamRecord`/`JvmValue` → `RawRecord`/`TraceValue` (`Boxed.type_name` `java.lang.Integer` → `BoxKind::Int`…, `Character` mã int → ký tự; `Str{text: None}` → `truncated: true`; `Array` → `Object{class}`; `Failed("notFound")` → `ReadError::NotFound`; `Unsupported` → `ReadError::Unsupported`).
  - `mute.rs`: `async fn mute(manager, session) -> IdeResult<()>` = `suspend_breakpoints(session, None)` + `setExceptionBreakpoints {filters: []}`; `async fn unmute(manager, session)` = `restore_breakpoints` + `send_exception_breakpoints`; so trạng thái trả về với `self.states`, khác thì ghi và phát `BreakpointsChanged`. `unmute` luôn chạy (trừ phiên đã kết thúc) sau `run_trace`, kể cả khi `run_trace` trả lỗi.
  - `cancel.rs`: khi `cancel` bị huỷ hoặc `TRACE_SOFT_TIMEOUT` trôi qua mà E1 chưa xong: `progress(Cancelling{Interrupt})`, `probe.thread(Interrupt)`, chờ `CANCEL_RUNG_WAIT`; `progress(Cancelling{Stop})`, `probe.thread(Stop{key})`, chờ; rồi `progress(Stuck{monitor_holders(except = thread_id)})` và chờ tiếp tới khi E1 trả về hoặc phiên kết thúc.
  - `mod.rs`: kiểm `capabilities().stream_trace`, `suspended`, `stream_busy.swap(true)` (thả trong mọi nhánh); `generation = suspended.ticket()` lúc bắt đầu.
- [ ] **Step 4: Chạy, xác nhận qua** — `cargo nextest run -p ide-dap`, PASS.
- [ ] **Step 5: Commit**

```bash
git add crates/ide-dap/src/stream_trace crates/ide-dap/src/lib.rs crates/ide-dap/src/session.rs crates/ide-dap/Cargo.toml Cargo.lock
git commit -m "feat(debugger): run stream traces with breakpoints muted and a cancel ladder"
```

### Task 8: `ide-host` và lệnh IPC

**Files:**

- Create: `crates/ide-host/src/ops/debug/streams.rs`
- Modify: `crates/ide-host/src/ops/debug.rs` (mod, `attach_jvm_inspector` gắn thêm `JdtStreamProbe`, `register`), `crates/ide-host/Cargo.toml` (`ide-streams`), `src-tauri/src/commands/debug.rs`, `src-tauri/src/commands/mod.rs`, `src/bindings.ts` (sinh)

**Interfaces:**

- Consumes: `find_chains`, `StopContext`, `normalize`, `hints_from_declared`, `build_plan`, `fresh_nonce`, `DEFAULT_BUDGET_RECORDS` (S1, Task 1–2); `LspManager::java_declared_types` (Task 6); `DebugManager::stream_trace`, `stream_resume_holder` (Task 7).
- Produces (IPC; kiểu ở `streams.rs`, derive `Type`):

```rust
pub enum StreamChainsResult { // tag "status", như JvmFieldsResult
    Ready { chains: Vec<StreamChainInfo>, rejected: Vec<RejectedChain>, source_modified: bool },
    Unavailable { reason: StreamUnavailable },
}
pub struct StreamChainInfo { pub index: u32, pub range: Range, pub text: String, pub steps: Vec<String>, pub warnings: Vec<ChainWarning> }
pub enum StreamTraceOutcome {
    Traced { steps: Vec<StepInfo>, result: TraceResult, adjustments: Vec<Adjustment>, warnings: Vec<ChainWarning>, generation: u64 },
    Rejected { rejection: Rejection },
    Failed { error: TraceError },
    Unavailable { reason: StreamUnavailable },
}
pub async fn debug_stream_chains(host, window, session: DebugSessionId, frame: StackFrame) -> IdeResult<StreamChainsResult>;
pub async fn debug_stream_trace(host, window, request: RequestId, session: DebugSessionId, thread_id: i64,
    frame: StackFrame, chain: u32, on_progress: Channel<StreamTraceProgress>) -> IdeResult<StreamTraceOutcome>;
pub async fn debug_stream_resume_holder(host, window, session: DebugSessionId, thread_id: i64) -> IdeResult<()>;
```

Tên đăng ký Dispatcher: `debug_stream_chains` (`session`, `frame`), `debug_stream_trace` (`request`, `session`, `threadId`, `frame`, `chain`, channel `onProgress`), `debug_stream_resume_holder` (`session`, `threadId`).

- [ ] **Step 1: Viết test hỏng** — test của `streams.rs` trên `Project` thử nghiệm có sẵn trong `ide-host` (mẫu test `ops/syntax.rs`), không cần jdtls:

```rust
#[tokio::test]
async fn chains_for_a_java_frame_list_traceable_and_rejected() {
    let (host, window, path) = host_with_file("Main.java", MAIN_WITH_TWO_CHAINS_ON_LINE_5);
    let StreamChainsResult::Ready { chains, rejected, source_modified } =
        debug_stream_chains(&host, &window, session(), frame(&path, 5, "Main.run(List)")).await.unwrap() else { panic!() };
    assert_eq!(chains.len(), 1);
    assert_eq!(chains[0].steps, ["filter", "map", "collect"]);
    assert_eq!(rejected[0].reason, Rejection::RootNotNewStream { root: "s".into() });
    assert!(!source_modified);
}

#[tokio::test]
async fn kotlin_frame_is_not_java() {
    let (host, window, path) = host_with_file("Main.kt", "fun main() {}");
    assert_eq!(debug_stream_chains(&host, &window, session(), frame(&path, 0, "MainKt.main")).await.unwrap(),
               StreamChainsResult::Unavailable { reason: StreamUnavailable::NotJavaFrame });
}

#[test]
fn stop_context_reads_lambda_frames() {
    assert!(stop_context(&frame(Path::new("/a/Main.java"), 3, "Main.lambda$run$0(Integer)")).in_lambda);
    assert_eq!(stop_context(&frame(Path::new("/a/Main.java"), 3, "Main.run()")).file_stem, "Main");
}
```

- [ ] **Step 2: Chạy, xác nhận hỏng** — `cargo nextest run -p ide-host streams`, FAIL.
- [ ] **Step 3: Cài đặt** — snapshot: `project.documents.open(path)` → `text_snapshot(info.id)` → `close(info.id)` (`source_modified = info.dirty`); `find_chains` trong `blocking` với token của request; `debug_stream_trace` tìm lại chuỗi theo `chain` (không nhận `StreamChain` từ UI), gọi `java_declared_types` cho `chain.facts.queries` khi có, `hints_from_declared`, `normalize`, `build_plan(&n, &fresh_nonce(), DEFAULT_BUDGET_RECORDS)`, rồi `host.debugger.stream_trace(…, host.begin_request(request), |p| on_progress.send(p))`, `host.end_request(request)`. Thêm wrapper Tauri mỏng ở `src-tauri/src/commands/debug.rs` theo mẫu `debug_jvm_memory_instances`, đăng ký trong `commands/mod.rs`; chạy `pnpm gen:bindings`.
- [ ] **Step 4: Chạy, xác nhận qua** — `cargo nextest run -p ide-host`, `pnpm typecheck`; PASS, `src/bindings.ts` có `debugStreamChains`, `debugStreamTrace`, `debugStreamResumeHolder`.
- [ ] **Step 5: Commit**

```bash
git add crates/ide-host/src/ops/debug/streams.rs crates/ide-host/src/ops/debug.rs crates/ide-host/Cargo.toml src-tauri/src/commands/debug.rs src-tauri/src/commands/mod.rs src/bindings.ts Cargo.lock
git commit -m "feat(debugger): expose stream chains and traces over IPC"
```

### Task 9: Frontend — action, hộp thoại Flat/Split

**Files:**

- Create: `src/features/debugger/streams/streamsState.ts`, `StreamTraceDialog.tsx`, `StreamTraceDialog.module.css`, `StepColumns.tsx`, `links.ts`, `src/features/debugger/__tests__/streams.test.ts`, `src/features/debugger/__tests__/streamDialog.test.tsx`
- Modify: `src/features/debugger/actions.ts` (action mới cạnh `debug.memory.refresh`), `src/features/debugger/state.ts:350-361` (context `debugCanTraceStream`), `src/features/debugger/ui/popoverStore.ts` (cờ `streamTrace`), `src/features/debugger/ui/Overlays.tsx`, `src/features/debugger/index.ts:45` (thêm cờ vào `useAnyOverlay`), `src/features/debugger/ui/DebugToolWindow.tsx` (nút toolbar), `src/ui/icons.tsx` (icon `stream-trace`), `src/platform/locales/text/en.json`, `zh.json`

**Interfaces:**

- Consumes: `commands.debugStreamChains`, `debugStreamTrace`, `debugStreamResumeHolder`, `debugJvmMemoryFields` (bindings); `sessionSupports("streamTrace", s)`; `nextRequestId`, `cancel_request`.
- Produces:
  - Action `debug.traceStreamChain`, title `"Trace Current Stream Chain"` (zh `"跟踪当前流链"`), category `"Debug"`, `when: "debugCanTraceStream"`; không có phím mặc định.
  - Context `debugCanTraceStream = paused && sessionSupports("streamTrace", s)`.
  - `streamsState.ts`: `useStreams` (zustand) theo session: `{ phase: "picking" | "running" | "done" | "error"; chains; trace?; progress?; mode: "flat" | "split"; selected?: { step: number; record: number }; stale: boolean }`; `traceStreamChain(sessionId)`, `pickChain(index)`, `cancelTrace()`, `resumeHolder(threadId)`, `markStale(sessionId)` (gọi từ `state.ts` khi phiên chạy tiếp hoặc dừng ở thế hệ khác).
  - `links.ts`: `related(links: Link[], drops: DistinctDrop[], record: number): Set<number>` — tổ tiên + hậu duệ theo `parent`, cộng `same_as` của drop.
- Hành vi: một chuỗi thì trace ngay; nhiều chuỗi thì danh sách chọn (text rút gọn + các bước); chuỗi bị từ chối hiện mờ kèm lý do. Đang chạy > 1 s: hiện "Đang trace…" + nút Huỷ; `Stuck` hiện tên thread kèm hai nút "Resume <tên> và huỷ" / "Khởi động lại phiên" (`debug.restart`). Kết quả: Flat = mọi bước thành cột cạnh nhau, đường nối SVG giữa cột kề nhau khi bước có `links` (không vẽ cho `gather`/`mapConcurrent`); Split = một tab mỗi phép toán, hai cột trước/sau. Chọn một ô thì tô `related`. Banner cho `CountFromSize`, `SortedPassThrough`, `Truncated`, `BudgetExceeded`, `WrongThread`, `Cancelled`, `DistinctByEquals` (cảnh báo đã gọi `equals` của chương trình), `DistinctUnresolved`, `adjustments`, `warnings`, `source_modified`, `cleanupFailed`. Giá trị object mở rộng lười qua `debugJvmMemoryFields({generation, id})`; `Collected`/`Stale` hiện chữ, không lỗi.
- Văn bản cho mọi `Rejection`, `EvalFailure`, `StreamUnavailable` (kể cả Kotlin: "Stream trace chỉ hỗ trợ phiên Java (java-debug)") đi qua text catalog, cả en và zh.

- [ ] **Step 1: Viết test hỏng**

```ts
test("action runs only for a paused session that supports stream trace", () => {
  expect(getAction("debug.traceStreamChain")!.when).toBe("debugCanTraceStream");
  setSession({ status: "paused", caps: { streamTrace: false } });
  expect(getContext("debugCanTraceStream")).toBe(false);
});

test("one chain traces immediately; several open the picker", async () => {
  mockIpc({ debug_stream_chains: chains(2) });
  await traceStreamChain(sid);
  expect(useStreams.getState().bySession[sid].phase).toBe("picking");
});

test("related walks ancestors, descendants and distinct matches", () => {
  const links = [{ parent: null }, { parent: null }, { parent: 0 }, { parent: 2 }];
  expect([...related(links, [{ dropped: 1, sameAs: 0 }], 2)].sort()).toEqual([0, 1, 2, 3]);
});

test("marks trace stale after resume", () => {
  seedDoneTrace(sid);
  markStale(sid);
  expect(useStreams.getState().bySession[sid].stale).toBe(true);
});

test("cancel sends cancel_request for the running trace", async () => {
  const pending = startTraceNeverResolving(sid);
  cancelTrace();
  expect(ipcCalls("cancel_request")).toEqual([{ request: pending.requestId }]);
});
```

`streamDialog.test.tsx`: render với kết quả 3 bước, bấm ô bước 1 → các ô liên quan có `aria-selected="true"`; chuyển Split → có `role="tab"` cho mỗi phép toán; trạng thái `Stuck` → nút có tên thread; banner `DistinctByEquals` hiện.

- [ ] **Step 2: Chạy, xác nhận hỏng** — `pnpm vitest run src/features/debugger/__tests__/streams.test.ts src/features/debugger/__tests__/streamDialog.test.tsx`, FAIL.
- [ ] **Step 3: Cài đặt** theo Interfaces; layout bằng tokens (`src/styles/tokens.css`), danh sách dài dùng ảo hoá có sẵn trong `src/ui/List.tsx`.
- [ ] **Step 4: Chạy, xác nhận qua** — cùng lệnh vitest, rồi `pnpm vitest run src/platform/locales` (`textCatalog.test.ts`), `pnpm typecheck`, `pnpm lint`; PASS.
- [ ] **Step 5: Commit**

```bash
git add src/features/debugger/streams src/features/debugger/__tests__/streams.test.ts src/features/debugger/__tests__/streamDialog.test.tsx src/features/debugger/actions.ts src/features/debugger/state.ts src/features/debugger/ui/popoverStore.ts src/features/debugger/ui/Overlays.tsx src/features/debugger/ui/DebugToolWindow.tsx src/features/debugger/index.ts src/ui/icons.tsx src/platform/locales/text/en.json src/platform/locales/text/zh.json
git commit -m "feat(debugger): add the Trace Current Stream Chain dialog"
```

### Task 10: Fixture ~30 chuỗi, smoke và bộ đo JDK 17/21/25

**Files:**

- Create: `fixtures/java-streams/pom.xml` (`maven.compiler.release` 17), `fixtures/java-streams/src/main/java/streams/Cases.java`, `fixtures/java-streams/src/main/java/streams/Main.java`, `fixtures/java-streams/README.md`, `smoke/streams.test.ts`
- Modify: `fixtures/README.md` (một dòng)

**Interfaces:**

- Consumes: IPC của Task 8 qua `call` như `smoke/debug.test.ts`; `javaExec` trong `extraJson` của launch java-debug (`src/features/debugger/java.ts`).
- Produces: mỗi ca một dòng đánh dấu `// TRACE cNN expect=<ok|reject:<kind>> counts=<n0>,<n1>,… result=<text>`; `smoke/streams.test.ts -t <17|21|25>` đọc JDK từ `OPENIDEA_STREAM_JDK_<NN>` (đường dẫn `bin/java`), ghi `target/stream-bench/jdk<NN>.json` `{ jdk, cases: [{ id, outcome: "correct"|"wrong"|"rejected"|"failed", reason?, totalMs, e2Ms }], correctRate, p95Ms }`.

Danh sách ca (đặt mỗi ca trong method riêng của `Cases.java`; frame ghi trong ngoặc):

| id  | chuỗi (rút gọn)                                                                                                    | kỳ vọng engine A                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| c01 | `nums.stream().filter(x -> x % 2 == 0).map(x -> x * k).collect(toList())`                                          | ok                                                                       |
| c02 | `IntStream.range(0, 20).map(i -> i * i).boxed().collect(toList())`                                                 | ok                                                                       |
| c03 | `words.stream().map(String::toUpperCase).sorted().collect(joining(","))`                                           | ok                                                                       |
| c04 | `nums.stream().distinct().count()` (List, không SIZED sau distinct)                                                | ok                                                                       |
| c05 | `people.stream().distinct().collect(toList())` (record `Person` file riêng, `equals`)                              | ok + `DistinctByEquals`                                                  |
| c06 | `nums.stream().sorted(Comparator.reverseOrder()).limit(3).collect(toList())`                                       | ok                                                                       |
| c07 | `nums.stream().skip(2).takeWhile(x -> x < 9).collect(toList())`                                                    | ok                                                                       |
| c08 | `lists.stream().flatMap(List::stream).mapToInt(Integer::intValue).sum()`                                           | ok                                                                       |
| c09 | `nums.stream().peek(sink::add).count()` (`List<Integer> sink`)                                                     | ok (carry alias)                                                         |
| c10 | `var opt…; nums.stream().map(x -> opt.map(Duration::toMillis).orElse(0L) + x)…`                                    | ok (declaredTypes)                                                       |
| c11 | `var groups = new HashMap<String, List<Integer>>(); nums.stream().map(x -> groups.size() + x)…`                    | ok                                                                       |
| c12 | `<T extends Comparable<T>> … xs.stream().filter(t -> counts.get(t) > 0).count()`                                   | ok (bound)                                                               |
| c13 | `o instanceof HashMap h ? h.size() : 0` trong lambda, `Map<String,Integer> o`                                      | ok (rule 6)                                                              |
| c14 | `nums.stream().map(x -> { int y = x * 2; return y + 1; })…`                                                        | ok                                                                       |
| c15 | `nums.stream().map(x -> Cases.helper(x))…` (static public)                                                         | ok                                                                       |
| c16 | `nums.stream().map(x -> twice(x))…` (static private, không qualify)                                                | ok (rule 4)                                                              |
| c17 | `nums.stream().map(this::inst)…` (instance public)                                                                 | ok                                                                       |
| c18 | `nums.stream().map(x -> priv(x))…` (instance private)                                                              | reject:privateMethodInLambda                                             |
| c19 | `nums.parallelStream().map(x -> x + 1).collect(toList())`                                                          | ok + `ParallelRemoved`                                                   |
| c20 | `Stream.iterate(1, x -> x * 2).limit(10).collect(toList())`                                                        | ok                                                                       |
| c21 | `"hello".chars().filter(Character::isLetter).count()`                                                              | ok                                                                       |
| c22 | `Arrays.stream(arr).map(x -> x / (x - 3)).sum()` (ném ArithmeticException)                                         | ok (`Threw`)                                                             |
| c23 | `nums.stream().count()` (nguồn SIZED)                                                                              | ok + `CountFromSize`                                                     |
| c24 | frame `Nested.go` (class lồng static) `xs.stream().map(x -> x + 1)…`                                               | ok                                                                       |
| c25 | frame `Member.go` (inner class)                                                                                    | ok                                                                       |
| c26 | frame record lồng `Pair.sum`                                                                                       | reject:unsupportedFrame                                                  |
| c27 | `IntStream.range(0, 1_000_000).filter(x -> true).boxed().collect(toList())`                                        | ok + `BudgetExceeded` (đúng = 50.000 bản ghi đầu khớp `counts` cắt ngắn) |
| c28 | `nums.stream().map(x -> { try { return Integer.parseInt("q"); } catch (NumberFormatException e) { return x; } })…` | reject:catchInLambda                                                     |
| c29 | `nums.stream().map(x -> switch (x) { case 1 -> 10; default -> x; })…`                                              | reject:switchExpression                                                  |
| c30 | frame lambda của lớp ẩn danh `new Runnable() { … }`                                                                | reject:unsupportedFrame                                                  |
| c31 | `Main.nap` 3 s trong `map` rồi Huỷ (kiểm thang huỷ, không tính vào tỉ lệ)                                          | `Cancelled` < 5 s                                                        |

Quy ước tính: "correct" = trace xong, đúng `counts` từng bước và đúng `result`; `reject:*` và lỗi evaluate tính là không đúng; một trace xong mà sai `counts`/`result` là **"wrong" và làm smoke FAIL** (R8: sai mà không báo). Tỉ lệ = correct / 30 (c31 ngoài mẫu số).

- [ ] **Step 1: Viết smoke và fixture** — `streams.test.ts` dựng `Server` như `smoke/debug.test.ts`, mở `fixtures/java-streams`, đặt breakpoint ở mọi dòng `// TRACE`, debug `Main` với `javaExec`, mỗi lần dừng: `debug_stream_chains` → `debug_stream_trace` → so kỳ vọng → `continue`. Kiểm thêm sau mỗi ca: `debug_breakpoint_states` không đổi số lượng, `evaluate "1 + 1"` → `2`.
- [ ] **Step 2: Chạy, xác nhận hỏng trước khi Task 7–8 có** — bỏ qua nếu làm sau Task 8; khi làm sau thì chạy thẳng Step 3.
- [ ] **Step 3: Chạy bộ đo trên ba JDK**

Run (lần lượt, không gộp một lệnh shell):

```
cargo build -p ide-host --bin openidea-server
OPENIDEA_STREAM_JDK_17=<jdk17>/bin/java pnpm smoke smoke/streams.test.ts -t 17
OPENIDEA_STREAM_JDK_21=<jdk21>/bin/java pnpm smoke smoke/streams.test.ts -t 21
OPENIDEA_STREAM_JDK_25=<jdk25>/bin/java pnpm smoke smoke/streams.test.ts -t 25
```

Expected: không ca nào "wrong", phiên sống tới hết, c31 `Cancelled` < 5 s; in bảng `id | 17 | 21 | 25` và `correctRate`, `p95Ms` mỗi JDK.

- [ ] **Step 4: Ghi kết quả** — dán bảng vào mô tả PR (mục "How it was verified") và gửi coordinator kèm quyết định theo quy tắc ở mục "Quy tắc quyết định S3/S4".
- [ ] **Step 5: Commit**

```bash
git add fixtures/java-streams fixtures/README.md smoke/streams.test.ts
git commit -m "test(debugger): add the stream trace fixture and JDK benchmark smoke"
```

### Task 11: e2e, xác minh trên app, bộ kiểm như CI

**Files:**

- Modify: `e2e/debug.spec.ts` (ca stream trace với IPC giả của e2e)

- [ ] **Step 1: Viết test e2e** — phiên giả đang dừng có `streamTrace: true`, IPC giả trả 2 chuỗi và một kết quả 3 bước: chạy action từ Command Palette, chọn chuỗi thứ hai, kiểm cột và đường nối hiện, chuyển Split, đóng bằng Esc.
- [ ] **Step 2: Chạy** — `pnpm e2e e2e/debug.spec.ts`, PASS.
- [ ] **Step 3: Xác minh runtime** — skill `.agents/skills/verify` với `fixtures/java-streams` trên JDK 21: trace c01 (Flat, Split), c05 (banner equals), c26 (từ chối), c31 (Huỷ); chụp ảnh trước/sau; kiểm breakpoint còn nguyên trong gutter sau mỗi trace.
- [ ] **Step 4: Bộ kiểm như CI** (mỗi lệnh một lần gọi):

```
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo nextest run --workspace
pnpm gen:bindings && git diff --exit-code src/bindings.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm knip
pnpm test
pnpm build
pnpm e2e
```

Expected: tất cả PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/debug.spec.ts
git commit -m "test(debugger): cover the stream trace dialog end to end"
```

---

## Phiên Kotlin

S2 chỉ làm Java. Với phiên `kotlin-lsp` (debugger chính của Kotlin từ K1) và `kotlin-debug-adapter` (dự phòng): `stream_trace = false`, nên action không hiện; nếu gọi thẳng IPC thì trả `Unavailable { NotJavaDebug }`. Phiên java-debug dừng trong file `.kt` (dự án trộn) trả `NotJavaFrame`, vì tree-sitter-java không đọc được nguồn Kotlin và chuẩn hoá của S1 là cho Java. `Sequence` của Kotlin vẫn là không phải mục tiêu v1 (§1). Bundle `jvm-inspect` không chạy trong phiên Kotlin (JVM do `JdwpLink` nắm), nên muốn hỗ trợ sau này phải có `StreamProbe` trên `JdwpLink` (đọc field, chia khúc ≤ 16.384) và một bộ chuẩn hoá cho evaluate của kotlin-lsp; xem "Cần chủ repo quyết định" 3.

## Quy tắc quyết định S3/S4 (§10.5)

Đầu vào là `target/stream-bench/jdk{17,21,25}.json` của Task 10.

1. Engine A đạt khi **mỗi** JDK 17, 21, 25 có `correctRate ≥ 0,70` (≥ 21/30 ca đúng) **và** `p95Ms < 300`; và không có ca "wrong" nào.
2. A đạt: v1 phát hành engine A; S3/S4 chỉ làm khi có số đo mới chứng minh cần (ca bị từ chối có giá trị cao).
3. A dưới 70% ở bất kỳ JDK nào: v1 **hoặc** chỉ hỗ trợ JDK ≥ 23 (đầu tư S4, compile-and-define, vì JDK 21 hỏng lambda trong hidden class, JDK-8330467) **hoặc** đầu tư S3 (trace lần chạy thật, phủ cả 17/21). Chủ repo chọn (xem "Cần chủ repo quyết định" 4).
4. Ngưỡng B ≥ 95% áp cho engine thay thế (S3 hoặc S4) và đo bằng **chính** bộ ca này khi engine đó có; S2 không đo B.
5. `p95Ms ≥ 300` dù tỉ lệ đạt: mở việc tối ưu trước S3/S4 (ước lượng từ G1: phần lớn thời gian là E1, 33–127 ms).

Theo các ràng buộc đã đo (G3), dự đoán trước khi chạy: 5 ca chắc chắn bị từ chối (c18, c26, c28, c29, c30), tức trần 25/30 ≈ 83%; con số thật là kết quả của Task 10, không dùng dự đoán này để quyết.

## Sửa spec đề xuất (coordinator áp vào spec; plan này không sửa spec)

1. **§10.1 bước 4–5, định dạng bộ ghi:** thay "mỗi `peek` thêm `Integer.valueOf(k)` rồi `x`" bằng bố cục `list[0]` `StringBuilder` chỉ mục (một dòng `k|class|…` mỗi phần tử, ngữ pháp ở "Quyết định thiết kế" 1), `list[1]` `RuntimeException("oi-cancel:<nonce>")`, `list[2..]` phần tử; ngân sách đếm bản ghi, mặc định 50.000, cộng trần chỉ mục 2.000.000 ký tự. Số đo: định dạng cũ cần xem trước từng object (~78 µs mỗi object khác nhau): 10k bản ghi E2 771–815 ms, trace 814–860 ms trên 17/21/25, vượt 300 ms; định dạng gọn 10k: E2 15 ms, trace 71–79 ms; 50k: E2 46–52 ms, trace 111–112 ms (G1).
2. **§10.1 bước 5 và §6/§7, đọc mảng qua JDWP:** thêm bất biến "mỗi `ArrayReference.GetValues` trên mảng object ≤ 16.384 phần tử". Số đo: 65.537 phần tử làm JVM debuggee abort (`AGENT_ERROR_OUT_OF_MEMORY(188): PushLocalFrame`) trên 17/21/25, 65.536 an toàn, 100.002 phần tử theo khúc 16.384 mất 25–30 ms (G2). Áp cho cả `JdwpLink` (M2) và việc đọc mảng của Coroutine view (M3); `fields` (100 phần tử) và quét referrer (≤ 10.000) hiện vẫn an toàn.
3. **§10.3 quy tắc 3, kiểu khai báo:** thay "lấy từ jdtls hover" bằng lệnh JDT binding `openidea.java.declaredTypes` (tên đầy đủ, cờ capture/anonymous/local); alias thô chỉ cho kiểu capture. Số đo: hover trả tên ngắn `Optional<Duration>` → evaluate lỗi "Duration cannot be resolved to a type"; tên đầy đủ OK; JDT trả `java.util.Optional<java.time.Duration>` trong 11–14 ms (không cache), 0–14 ms (cache); alias thô cho `var groups = new HashMap<…>()` lỗi "The method size() is undefined for the type Object" (G3).
4. **§10.3 quy tắc 3 và 8, biến kiểu:** "frame generic: cast về erasure" → "thay mỗi biến kiểu trong kiểu cast bằng erasure của bound đầu (không bound: `Object`)". Số đo: `((Map<T, Integer>) …)` lỗi "T cannot be resolved to a type"; `((java.util.Map<Comparable, Integer>) …)` và `((java.util.Map) …)` OK (G3).
5. **§10.3 quy tắc 8, frame record:** thêm "record lồng trong một kiểu khác: từ chối cả trace". Số đo: mọi lambda, kể cả `java.util.stream.Stream.of` đã qualify, lỗi "Functional expressions cannot be evaluated inside local and or anonymous classes" trên 17/21/25; class lồng static và inner class trace OK 55–82 ms (G3).
6. **§10.3, quy tắc mới 10:** "`catch (X e)` trong thân lambda khối của chuỗi: từ chối". Số đo: "Cannot find the variable e:" 2/2 trên mỗi JDK, có hay không exception breakpoint; biến local trong lambda khối OK (G3).
7. **§10.3, quy tắc mới 11:** "mọi việc theo từng phần tử nằm trong thân lambda; code ngoài lambda bị JDT thông dịch". Số đo: vòng lặp ngoài lambda 10.000 lần `equals` 8,1 s, 100.000 lần 76 s; cùng việc trong lambda 25.000.000 lần 77 ms (G6).
8. **§10.4 `distinct`:** "tính ở E2" → "một `evaluate` E2b sau E2, trước E3, vị trí truyền bằng một hằng `String`, vòng lặp trong lambda, trần 5.000 phần tử mỗi phía mỗi bước". Số đo: 5.000 × 5.000 → 77 ms, biểu thức 48,5 KB (G6).
9. **§10.3 "An toàn phiên" và §15 thí nghiệm 4–5 (đã làm):** ghi lại: java-debug dừng breakpoint bằng `SUSPEND_EVENT_THREAD` (thread khác vẫn chạy: ticks 6268 → 7076 trong 1 s); breakpoint trong lambda cùng thread và exception breakpoint "mọi exception" không gây `stopped` trong evaluate (ngoại lệ trả như giá trị); `setBreakpoints []` rồi gửi lại đổi id, giữ `verified`, không echo điều kiện → khôi phục từ store và ánh xạ lại id; evaluate không có timeout JDI (5 s OK) và java-debug không trả lời request khác trong lúc đó (G4).
10. **§10.3 "An toàn phiên", hết giờ:** "báo phiên có thể treo và đề nghị khởi động lại" → thang huỷ đã đo: `interrupt` (gỡ `sleep`), `Thread.stop(oi-cancel)` (gỡ vòng lặp bận), rồi liệt kê thread bị debugger dừng có giữ monitor để người dùng chọn resume (gỡ khoá; `currentContendedMonitor` không dùng được vì thread đang invoke), cuối cùng mới khởi động lại phiên. Số đo: G5 (cả ba ca phiên sống; không resume holder thì phiên chết).
11. **§13 IPC:** `debug_stream_chains(session, frame: StackFrame)` thay `frame_id` (backend không giữ cache frame; UI có sẵn `StackFrame`), `debug_stream_trace(request, session, thread_id, frame, chain, on_progress)`, thêm `debug_stream_resume_holder(session, thread_id)`.
12. **§14, bộ đo:** `fixtures/java-streams` + `smoke/streams.test.ts -t <jdk>`; ca "trace xong nhưng sai" làm test FAIL (R8).

## Cần chủ repo quyết định (kèm mặc định đề xuất)

1. **Resume thread giữ khoá khi trace bị kẹt.** Việc này đổi trạng thái chương trình (thread đó chạy tiếp, có thể chạm breakpoint đã tắt tạm). _Mặc định:_ có nút "Resume <thread> và huỷ trace", chỉ khi người dùng bấm; không bao giờ tự làm.
2. **Bộ đo JDK có vào CI không.** Cần ba JDK và một bản dựng `openidea-server` (~vài phút mỗi JDK). _Mặc định:_ S2 chạy tay, opt-in bằng `OPENIDEA_STREAM_JDK_<NN>`, kết quả dán vào PR; đưa vào CI (giống `Language smoke`) khi chọn S3/S4.
3. **Stream trong code Kotlin.** Phiên Kotlin gọi `java.util.stream` từ file `.kt` chưa được spec nhắc. _Mặc định:_ S2 tắt kèm lý do; xét lại sau S3/S4 (cần `StreamProbe` trên `JdwpLink` và chuẩn hoá cho evaluate của kotlin-lsp).
4. **Khi A < 70%: S3 hay "chỉ JDK ≥ 23" (S4).** _Mặc định:_ S3, vì S4 bỏ JDK 17 và 21 (hai LTS đang dùng nhiều nhất); quyết sau khi có số Task 10.
5. **Issue theo dõi (mặc định 7 của spec, chưa được đồng ý).** PR của S2 cần `Closes #n`. _Mặc định:_ tạo một issue "Stream Debugger" trước PR đầu của S2 khi chủ repo đồng ý đẩy nội dung lên GitHub.

## Ghi chú cho các milestone khác

- **M2/M3 (`JdwpLink`, Coroutine view):** mọi `ArrayReference.GetValues` trên mảng object phải chia khúc ≤ 16.384 (G2, "Sửa spec đề xuất" 2). M2 hiện an toàn (`ARRAY_PREVIEW = 100`, `REFERRER_ARRAY_SCAN = 10_000`, `MAX_INSTANCES = 1000`), nhưng một hằng tăng lên ≥ 65.537 sẽ làm JVM người dùng abort.
- **PR:** theo `CONTRIBUTING.md` một vấn đề mỗi PR; đề xuất tách hai PR: (a) Task 1–8 + 10 (engine, bundle, IPC, smoke), (b) Task 9 + 11 (UI). Coordinator chốt cách đóng gói.
