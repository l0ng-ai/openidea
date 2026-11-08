# M3: Coroutine view cho phiên Kotlin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phiên debug Kotlin có tab **Coroutines**. Khi VM dừng, tab liệt kê mọi coroutine kotlinx đang sống: tên, trạng thái job, đang chạy trên thread nào hay đang treo, dispatcher, cha/con, và frame (thread + async, kèm frame lúc tạo khi bật agent). Nhóm được theo dispatcher hoặc theo cây job; copy được dump. Không bao giờ chạy code trong VM.

**Architecture:** `JdwpLink` thêm `batch()`: chạy nhiều lệnh JDWP ngắn kiểu pipeline trong một lượt chèn. `JvmInspector` thêm `read()`: mỗi lần là một "đợt" đọc độc lập (field theo tên, static, chuỗi, mảng, stack các thread, `Instances`, `InstanceCounts`, class con, classpath), `LinkInspector` cài nó bằng `batch`. Bộ giải mã coroutine nằm trong `ide-jvm-inspect::coroutines`, chỉ phụ thuộc trait:

- **Nguồn Graph** (mặc định): đi đồ thị từ stack thread và hàng đợi `delay`, rồi **kiểm khoảng hở**: `InstanceCounts` trên các class coroutine; class nào đếm được nhiều hơn số đã thấy thì `Instances` làm gốc mới.
- **Nguồn Agent**: registry của `DebugProbesImpl` khi agent đã nạp.

Dòng lệnh của frame async lấy từ `@DebugMetadata` trong bytes `.class`, tìm qua `VirtualMachine.ClassPaths`. `ide-dap` nối vào phiên (capability `jvm_coroutines`, IPC `debug_jvm_coroutines`). Frontend nằm ở `src/features/debugger/coroutines/`.

**Tech Stack:** Rust 2024 (`cargo +1.96`), tokio, crate `zip` 9 của workspace (deflate), specta/tauri-specta; React + CSS Modules + tokens, vitest; Kotlin 2.0.21 + kotlinx-coroutines cho fixture.

**Spec:** `docs/superpowers/specs/2026-11-07-jvm-debug-link-design.md`: §9 (Coroutine view), §6 (JdwpLink), §13 (tích hợp), §14 (kiểm thử), §15 (M3 phụ thuộc M2, K1), §17.4. Ledger M2: `.superpowers/sdd/2026-11-07-debugger-jvm-instances-m2/progress.md` (các Ruling về `InspectError::TimedOut` là lỗi tạm và lệnh inspect không huỷ được).

## Global Constraints

- **Không bao giờ invoke** (spec §9). Chỉ gửi lệnh JDWP đọc, và chỉ khi VM đang dừng (§6.1 bất biến 4, được nới ở Task 1 theo mục "Sửa spec đề xuất" 1).
- Pipeline: `BATCH_WINDOW = 8` lệnh đang bay. Chỉ dùng cho lệnh ngắn. `InstanceCounts` (1/21) và `Instances` (2/16) luôn chạy một lệnh một lúc qua `command()` (§6.1 bất biến 5 vẫn đúng cho lệnh dài).
- Trong một batch, mỗi lần ghi phải kiểm `core.invokes` rỗng. Có invoke của adapter đang chờ thì **chờ nó xong** (trong timeout của batch) rồi kiểm lại `SuspendCount` và generation; không trả `Busy`.
- Mã lỗi JDWP `INVALID_FRAMEID = 30`, `INVALID_OBJECT = 20`, `INVALID_THREAD = 10`.
- Bộ giải mã: `MAX_COROUTINES = 20_000` (vượt thì `truncated: true`), `MAX_ASYNC_FRAMES = 256` mỗi coroutine, `MAX_NODE_LIST = 100_000` nút mỗi danh sách.
- Tự làm mới khi dừng chỉ chạy kiểm khoảng hở nếu lần kiểm trước của phiên mất ≤ `AUTO_GAP_BUDGET = 300 ms`. Nếu không, `complete: false`. Đây là mặc định của quyết định 1.
- Field có tên khác nhau giữa các bản: thử theo thứ tự `"_state$volatile"`, `"_state"`; `"_parentHandle$volatile"`, `"_parentHandle"`; `"_next$volatile"`, `"_next"`; `"_delayed$volatile"`, `"_delayed"`; `"_rootCause$volatile"`, `"_rootCause"`; `"_isCompleting$volatile"`, `"_isCompleting"`.
- Chỉ số dòng: `line = DebugMetadata.l[label - 1]` khi `1 ≤ label ≤ l.len()`, ngược lại là `None` (như `BaseContinuationImpl.getStackTraceElement`).
- Tên class trong model ở dạng binary dùng dấu chấm (`kotlinx.coroutines.StandaloneCoroutine`, `probe.MainKt$main$1$7`). Tiền tố gói coroutine được dò từ class đã nạp kết thúc bằng `kotlinx/coroutines/JobSupport;`, nên bản shade dùng cùng mã.
- IPC theo §13: `IdeResult<T>`, gọi `host.require_trust(window)`, đăng ký ở `ops/debug.rs::register`. Đổi kiểu thì chạy `pnpm gen:bindings` và commit `src/bindings.ts`. Lệnh không huỷ được (Ruling M2); resume làm lệnh trả `Stale`.
- Frontend: không import tính năng khác; mọi hành vi là action có id ổn định (`debug.coroutines.refresh`, `debug.coroutines.deepScan`, `debug.coroutines.copyDump`), không phím mặc định. Mọi chuỗi hiển thị vào `en.json` + `zh.json` (title action có bản zh khác en). CSS Modules + tokens, icon từ `src/ui/icons.tsx`, `aria-label` cho nút icon.
- Nội dung dump là văn bản kỹ thuật tiếng Anh (như stack trace), không đi qua text catalog. Định dạng ở Task 9.
- Test JVM thật để `#[ignore]`, đọc `OPENIDEA_TEST_JAVA` (như `real_jvm.rs`). Không đưa probe của spike vào repo.
- Commit: `feat(debugger): …`. Stage từng đường dẫn tường minh, không `git add -A`, không trailer Co-Authored-By hay attribution AI.

## Grounding

Rủi ro làm sập cách làm: **đọc field qua JDWP mà không invoke, không agent, không quét heap, có tìm đủ coroutine trên 1.5.2–1.11.0 không, và nhanh tới mức nào qua `JdwpLink` thật?** Cùng với đó: kotlin-lsp có để link chèn lệnh lúc nó invoke không, và `.class` có tìm được qua classpath của debuggee không.

Probe nằm ngoài repo (`scratchpad/m3-spike/`): `tools/m3probe.py` (client JDWP Python, đếm lệnh), `linkprobe/` (crate Rust dùng `ide-jdwp` thật theo path), `tools/k0m3.py` (kotlin-lsp 263.7084 DAP, attach như K1), `tools/classpaths.py`. Fixture `app/src/main/kotlin/probe/Main.kt` chứa mọi trường hợp ở bảng của Task 7. JDK 21.0.4 trừ khi ghi khác. Mọi JVM, Gradle daemon và kotlin-lsp do probe mở đều đã dừng theo pid.

**G1. Độ phủ khi đi đồ thị** (gốc: stack thread + `DefaultExecutor`/`BlockingEventLoop._delayed`; lên cha qua `_parentHandle`, xuống con qua `ChildHandleNode`, tới leaf qua `ChildContinuation → CancellableContinuationImpl.delegate → DispatchedContinuation.continuation`). Đối chiếu với quét `Instances`:

```
== g1-1.5.2   WALK roots=['threads', 'executor']: jobs=21 leaves=12 in 35 ms, 499 JDWP commands
              COVERAGE: walk found 21/22 jobs; missed 1
                 MISSED kotlinx.coroutines.StandaloneCoroutine {'name': 'global-raw', 'dispatcher': 'DefaultScheduler'} state kotlinx.coroutines.Empty
== g1-1.6.4   WALK ...: jobs=21 leaves=12 in 32 ms, 499 JDWP commands    COVERAGE: walk found 21/22 jobs; missed 1 (global-raw)
== g1-1.7.3   WALK ...: jobs=22 leaves=13 in 35 ms, 521 JDWP commands    COVERAGE: walk found 22/23 jobs; missed 1 (global-raw)
== g1-1.8.1   WALK ...: jobs=22 leaves=13 in 34 ms, 520 JDWP commands    COVERAGE: walk found 22/23 jobs; missed 1 (global-raw)
== g1-1.9.0   WALK ...: jobs=22 leaves=13 in 37 ms, 523 JDWP commands    COVERAGE: walk found 22/23 jobs; missed 1 (global-raw)
              SCAN: jobs=23 conts=35 jobClasses=9 contClasses=33 nonzero job/cont=7/30 classWalk=11ms InstanceCounts=6ms Instances=143ms total=160ms cmds=252
              LEAVES: truth 23 (non-template, not a completion); walk 13; running 3; missed 7
                 MISSED LEAF probe.MainKt$main$1$9 owner StandaloneCoroutine {'name': 'raw-suspend'}
                 MISSED LEAF probe.MainKt$main$1$13 owner StandaloneCoroutine {'name': 'global-raw'}
                 MISSED LEAF probe.MainKt$main$1$7 owner StandaloneCoroutine {'name': 'with-context'}
                 MISSED LEAF probe.MainKt$main$1$4 owner StandaloneCoroutine {'name': 'io-blocked'}
                 MISSED LEAF probe.MainKt$main$1$8 owner StandaloneCoroutine {'name': 'scope-parent'}
                 MISSED LEAF probe.MainKt$main$1$cancelling$1 owner StandaloneCoroutine {'name': 'cancelling'}
                 MISSED LEAF probe.MainKt$main$1$lazy$1 owner LazyStandaloneCoroutine {'name': 'lazy-never-started'}
== g1-1.10.2  WALK ...: jobs=22 leaves=13 in 39 ms, 522 JDWP commands    COVERAGE: walk found 22/23 jobs; missed 1 (global-raw)
== g1-1.11.0  WALK ...: jobs=22 leaves=13 in 35 ms, 523 JDWP commands    COVERAGE: walk found 22/23 jobs; missed 1 (global-raw)
```

1.5.2 và 1.6.4 chạy với `-Dnoselect=1`, vì `select` biên dịch theo API 1.9 lỗi trên 1.5/1.6, huỷ `runBlocking` và làm fixture treo. Bốn trong bảy "missed leaf" là lambda ngoài của `withContext`/`coroutineScope`/`NonCancellable`. Chúng đến được qua `ScopeCoroutine.uCont`; probe không đi theo field này, bộ giải mã thì đi (Task 4). Lambda lazy chưa chạy thì đúng là không có frame. Chỉ hai ca `suspendCoroutine` thô (`raw-suspend`, `global-raw`) là thật sự không có frame.

**G6. Đi đồ thị khi không có gì neo** (app kiểu server: `CoroutineScope(SupervisorJob() + Dispatchers.Default)`, main thread không ở trong coroutine; thêm `-Dunanchored=1`, 1.9.0):

```
có một coroutine đang delay:  WALK roots=['threads', 'executor']: jobs=8 leaves=6 in 13 ms, 244 JDWP commands
                              COVERAGE: walk found 8/9 jobs; missed 1
                                 MISSED kotlinx.coroutines.CompletableDeferredImpl {} state kotlinx.coroutines.ResumeAwaitOnCompletion
không coroutine nào delay:    WALK roots=['threads', 'executor']: jobs=0 leaves=0 in 2 ms, 26 JDWP commands
                              SCAN: jobs=8 conts=6 jobClasses=6 contClasses=8 nonzero job/cont=3/6 classWalk=9ms InstanceCounts=5ms Instances=32ms total=45ms cmds=190
                              COVERAGE: walk found 0/8 jobs; missed 8
```

**Giả thuyết "đi đồ thị là đủ cho mặc định; quét `Instances` chỉ khi bấm Deep scan" (spec §9) bị bác.** Thiết kế đổi: snapshot mặc định thêm bước kiểm khoảng hở (Task 5). `CompletableDeferredImpl` là job thường, không phải coroutine, nên bộ đếm khoảng hở chỉ tính class con của `AbstractCoroutine`.

**G2. Chi phí.** 11 024 coroutine (`-Dmany=10000 -Dgmany=1000`), probe Python tuần tự:

```
WALK roots=['threads', 'executor']: jobs=11024 leaves=11013 in 12729 ms, 282565 JDWP commands
   commands by kind: {(9, 2): 162214, (9, 1): 109134, (1, 2): 11020, (3, 1): 67, (2, 4): 66, (11, 6): 20, (2, 5): 18, (2, 1): 17}
SCAN: jobs=11025 conts=44036 ... nonzero job/cont=7/36 classWalk=9ms InstanceCounts=43ms Instances=546ms total=599ms cmds=260
COVERAGE: walk found 11024/11025 jobs; missed 1
COST sequential GetValues: 38.5 us/command; with a SuspendCount check before each: 74.6 us/pair over 20017
COST pipelined window=16: 8.3 us/command over 20017
COST pipelined window=64: 6.4 us/command over 20017
```

`(1, 2)` ×11 020 là `ClassesBySignature` chưa cache. Có cache thì còn khoảng 24 lệnh mỗi coroutine. Qua `JdwpLink` thật (`linkprobe`, Rust, JDK 21, 20 017 coroutine):

```
LINKPROBE many=20000: Instances(StandaloneCoroutine)=20017 via link in 129 ms
LINKPROBE link.command sequential (SuspendCount + GetValues each): 77.8 us/command
LINKPROBE adapter-side through relay, sequential: 53.6 us/command
LINKPROBE adapter-side through relay, pipelined window 8: 10.8 us/command
LINKPROBE adapter-side through relay, pipelined window 32: 11.8 us/command
LINKPROBE adapter-side through relay, pipelined window 128: 14.0 us/command
LINKPROBE adapter-side through relay, pipelined window 512: 16.2 us/command
LINKPROBE jvm alive after dispose+resume: true
```

Ước lượng cho 10 000 coroutine × 24 lệnh: dùng `command()` mất ~18,7 s, dùng `batch` W=8 mất ~2,6 s. Quét trên heap 10M object + 10k coroutine (`-Dballast=10000000`):

```
JDK 21.0.4: SCAN: jobs=10025 conts=40036 jobClasses=9 contClasses=39 nonzero job/cont=7/35 classWalk=122ms InstanceCounts=488ms Instances=7123ms total=7734ms cmds=325
JDK 25.0.3: SCAN: jobs=10025 conts=40036 jobClasses=9 contClasses=39 nonzero job/cont=7/35 classWalk=124ms InstanceCounts=513ms Instances=6809ms total=7446ms cmds=325
```

`Instances` khoảng 170 ms mỗi class trên heap 10M. Kiểm khoảng hở chỉ cần các class job có thiếu (G6: 2–3 class), ~0,5 s + 0,17 s mỗi class. Deep scan thêm các class continuation (35 class): ~6 s. Không chạy được trên JDK 17: fixture biên dịch class version 65.

**G3. kotlin-lsp 263.7084, attach như K1, fixture coro của K0, 5 lần dừng.** Mỗi lần dừng probe chèn: statics `DebugProbesImpl`, AllThreads/Frames/ThisObject, đi job.

```
M3#1 {"suspendCount": 1, "DebugProbesImpl": null, "helperLoaded": true, "agentCaptureLoaded": false, ... "frameErrors": {}, "roots": 1, "threadsMs": 2, "jobsFound": 1, "ids": "10/10", "waitsForInvokes": 0, "waitMs": 0, "ms": 7}
 DAP threads: [(8, '"main"@1 in group "main": RUNNING'), (10, '"Attach Listener"@1,023: RUNNING'), (11, '"Common-Cleaner"@456 in group "InnocuousThreadGroup": WAIT'), (13, '"Notification Thread"@424: RUNNING'), ...]
M3#2 {... "ids": "14/14", "waitsForInvokes": 0, "ms": 7}    DAP threads: [(33, '"main"@1 in group "main": RUNNING'), ...]
M3#3 {... "ids": "14/14", "waitsForInvokes": 0, "ms": 9}
M3#4 {... "ids": "12/12", "waitsForInvokes": 0, "ms": 6}
M3#5 {... "ids": "12/12", "waitsForInvokes": 0, "ms": 8}
DAP event counts: {'initialized': 1, 'output': 2, 'stopped': 5, 'invalidated': 7, 'continued': 5, 'terminated': 1}
```

Attach kiểu K1 thì không có agent: `DebugProbesImpl` không nạp nên không có registry, chỉ còn nguồn Graph. Helper của kotlin-lsp có nạp nhưng ta không dùng (không invoke). Id thread DAP đổi mỗi lần dừng (8, 33, 73…). Tên DAP mang `@<JDWP objectID>` có dấu phẩy nhóm số: main↔`@1`, `@456`, `@424` khớp `AllThreads`.

**G4. `VirtualMachine.ClassPaths` (1/13), Gradle 8.5.** `run --debug-jvm` trả 6 mục, `test --debug-jvm` trả 14:

```
CLASSPATHS n: 6
    …/app-gradle/build/classes/java/main
    …/app-gradle/build/classes/kotlin/main
    …/app-gradle/build/resources/main
    ~/.gradle/caches/modules-2/…/kotlinx-coroutines-core-jvm-1.9.0.jar
    ~/.gradle/caches/modules-2/…/kotlin-stdlib-2.0.21.jar
    ~/.gradle/caches/modules-2/…/annotations-23.0.0.jar
FOUND probe/MainKt$level2$1.class in ['…/app-gradle/build/classes/kotlin/main']
FOUND kotlinx/coroutines/JobSupport.class in ['…/kotlinx-coroutines-core-jvm-1.9.0.jar']
== test
CLASSPATHS n: 14
    ~/.gradle/caches/8.5/workerMain/gradle-worker.jar
    …/app-gradle/build/classes/kotlin/test
    …/app-gradle/build/classes/kotlin/main
    … (coroutines, stdlib, junit jars)
FOUND probe/MainKt$level2$1.class in ['…/app-gradle/build/classes/kotlin/main']
```

Chưa kiểm: fat jar Spring Boot (`BOOT-INF/classes`, jar lồng) **[SL]**.

**G5. Chi phí agent** (bench của fixture, vòng 2, ms):

```
== 1.9.0 no agent                  BENCH round=2 yield1M=55ms  launch200k=483ms deep20x80k=17ms
== 1.9.0 agent, creation stacks off BENCH round=2 yield1M=49ms  launch200k=223ms deep20x80k=346ms
== 1.9.0 agent default             BENCH round=2 yield1M=110ms launch200k=215ms deep20x80k=367ms
== 1.10.2 no agent                 BENCH round=2 yield1M=236ms launch200k=673ms deep20x80k=23ms
== 1.10.2 agent default            BENCH round=2 yield1M=295ms launch200k=435ms deep20x80k=488ms
```

Agent làm resume chuỗi suspend sâu chậm ×20, đúng chiều với spec §9. Lần chạy này không tái hiện con số `launch` 200k (1470 ms so với 276 ms) của spec: số đo nhiễu do JIT. Nhưng kết luận "agent mặc định tắt" không đổi.

## Review Focus

1. **App không có gì neo** (scope riêng, mọi coroutine treo ở channel/await/mutex/callback): người dùng phải thấy đủ coroutine sau một lần dừng, không chỉ sau Deep scan. Test `gap_check_finds_unanchored_scope` (Task 5), `unanchored_scope_found_by_gap_check` (Task 7).
2. **Adapter invoke giữa lúc chụp** (kotlin-lsp gọi `toString` khi người dùng mở Variables): snapshot chờ rồi chạy tiếp, đọc lại stack thread, không hiện lỗi "Busy". Test `batch_waits_for_adapter_invoke` (Task 1), `threads_retry_after_adapter_ran` (Task 2).
3. **Resume/step khi đang chụp 10k coroutine**: không hiện dữ liệu cũ như mới, không có toast lỗi, lần dừng sau tự làm mới. Test `stale_snapshot_is_dropped` (Task 8), `coroutines_stale_on_resume` (Task 6).
4. **Không có `.class`** (fat jar, jar lồng, tên bị R8 đổi): frame vẫn hiện `Class.method`, kèm `missing: metadata`; snapshot không hỏng. Test `frame_without_metadata_uses_class_name` (Task 4), `unknown_layout_degrades` (Task 4).
5. **Thread không khớp** (fwcd, hay id thread JDWP được cấp lại): danh sách vẫn đúng, chỉ không ghim coroutine hiện tại. Test `matchThread` (Task 8).

---

## File Structure

| Đường dẫn                                                                                                                                                                  | Trách nhiệm                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `crates/ide-jdwp/src/ids.rs`                                                                                                                                               | thêm `ReplyIds::Objects`, `ReplyIds::TaggedObject`                                |
| `crates/ide-jdwp/src/link/batch.rs` (mới), `batch_tests.rs` (mới)                                                                                                          | `JdwpLink::batch`                                                                 |
| `crates/ide-jvm-inspect/src/read.rs` (mới)                                                                                                                                 | `Read`, `Answer`, `RawValue`, `ClassChain`, `ThreadStack`, `ThreadFrame`          |
| `crates/ide-jvm-inspect/src/lib.rs`                                                                                                                                        | `JvmInspector::read`, `JvmInspector::reads`                                       |
| `crates/ide-jdwp/src/inspector/read.rs`, `threads.rs` (mới), `wire.rs`, `fake.rs`, `read_tests.rs` (mới)                                                                   | `LinkInspector::read`                                                             |
| `crates/ide-jvm-inspect/src/coroutines/` (mới): `mod.rs`, `model.rs`, `metadata.rs`, `classpath.rs`, `walk.rs`, `state.rs`, `gap.rs`, `registry.rs`, `fake_heap.rs` (test) | model, parser `@DebugMetadata`, tìm `.class`, đi đồ thị, kiểm khoảng hở, registry |
| `crates/ide-dap/src/jvm_memory/coroutines.rs` (mới), `lib.rs`, `session.rs`                                                                                                | capability, `DebugManager::jvm_coroutines`, agent khi launch                      |
| `crates/ide-host/src/ops/debug.rs`, `src-tauri/src/commands/{debug,mod}.rs`, `src/bindings.ts`                                                                             | IPC `debug_jvm_coroutines`                                                        |
| `fixtures/kotlin-coroutines/` (mới), `fixtures/README.md`                                                                                                                  | fixture mọi trường hợp                                                            |
| `crates/ide-jdwp/tests/support/mod.rs` (tách từ `real_jvm.rs`), `tests/coroutines_real_jvm.rs` (mới)                                                                       | test JVM thật + ma trận phiên bản                                                 |
| `src/features/debugger/coroutines/` (mới): `coroutinesState.ts`, `coroutinesTree.ts`, `CoroutinesView.tsx`, `CoroutinesView.module.css`, `jumpToFrame.ts`, `dump.ts`       | UI                                                                                |
| `src/features/debugger/{actions.ts,state.ts,ui/DebugToolWindow.tsx}`, `src/features/run/jvmTypes.ts`, `src/features/debugger/java.ts`                                      | tab, action, tuỳ chọn agent                                                       |

Thứ tự: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Task 3 có thể làm song song với 1–2.

## Phụ thuộc K1

Mã của M3 không phụ thuộc adapter: capability đi theo việc phiên có inspector, mà M2 đã gắn inspector cho mọi phiên Kotlin. Hôm nay phiên đó chạy fwcd. Vì vậy Task 1–10 code và test được trước K1. Các bước xác minh trên kotlin-lsp phải chờ K1:

| Task M3                                         | Cần từ K1                                                                                                                         | Vì sao                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Task 6, bước xác minh trong app                 | K1 Task 2 (`kotlin_lsp::ADAPTER`, `kotlin::is_kotlin`, `JVM_MEMORY_ADAPTERS += kotlin-lsp`, link `hold_resumes:false` cho attach) | phiên kotlin-lsp mới có `jvm_inspector`                   |
| Task 8, ghim coroutine hiện tại trên kotlin-lsp | K1 Task 2 + K1 Task 3 (`Quirks::check_thread`: request mang thread id của lần dừng trước không được trả lời)                      | `matchThread` dùng danh sách thread của lần dừng hiện tại |
| Task 10                                         | không (dùng `start_kotlin_debuggee`, có sẵn cho cả fwcd và kotlin-lsp)                                                            |                                                           |
| Task 11 (smoke)                                 | K1 Task 6 (smoke `kotlin` chạy bằng kotlin-lsp)                                                                                   | smoke Coroutines nằm cạnh smoke Memory của K1             |

Trước khi K1 merge, Task 11 chạy smoke trên fwcd và ghi rõ điều này trong PR.

---

### Task 1: `JdwpLink::batch` — lệnh ngắn kiểu pipeline trong một lượt chèn

**Files:**

- Create: `crates/ide-jdwp/src/link/batch.rs`, `crates/ide-jdwp/src/link/batch_tests.rs`
- Modify: `crates/ide-jdwp/src/link/mod.rs` (khai báo mod, re-export), `crates/ide-jdwp/src/link/state.rs` (lượt chèn giữ được qua nhiều lệnh), `crates/ide-jdwp/src/ids.rs`, `crates/ide-jdwp/src/lib.rs`

**Interfaces:**

- Consumes: `JdwpLink::command` cùng các bất biến hiện có (turn, `SuspendCount`, generation, ledger, `upstream::is_invoke`).
- Produces:

```rust
// ids.rs
pub enum ReplyIds { /* có sẵn */ None, TaggedObjects, Values, ArrayRegion,
    /// `int n; objectID*` không tag — `VirtualMachine.AllThreads` (1/4).
    Objects,
    /// một `(tag, objectID)` — `StackFrame.ThisObject` (16/3).
    TaggedObject }

// link/batch.rs
pub const BATCH_WINDOW: usize = 8;
pub struct BatchCommand { pub set: u8, pub cmd: u8, pub body: Vec<u8>, pub ids: ReplyIds }
pub struct BatchReply {
    /// Theo đúng thứ tự `commands`. Lỗi từng lệnh: `LinkError::Jdwp(code)`.
    pub replies: Vec<Result<Vec<u8>, LinkError>>,
    /// Adapter đã chạy code trong VM (invoke) trong lúc batch chạy: frameID đọc trước đó có thể đã mất hiệu lực.
    pub adapter_ran: bool,
}
impl JdwpLink {
    pub async fn batch(&self, commands: Vec<BatchCommand>, timeout: Duration) -> Result<BatchReply, LinkError>;
}
```

Lỗi của cả batch: `NotSuspended`, `Stale` (generation đổi), `Closed`, `Degraded`, `TimedOut`. Batch không bao giờ trả `Busy`.

- [ ] **Step 1: Viết test thất bại** trong `batch_tests.rs`, dùng harness adapter/JVM giả của `command_tests.rs`:

```rust
#[tokio::test] async fn batch_pipelines_up_to_window() {
    // 20 lệnh GetValues; JVM giả ghi lại số lệnh đang bay cao nhất.
    // assert_eq!(jvm.max_in_flight(), BATCH_WINDOW); assert_eq!(reply.replies.len(), 20);
    // assert_eq!(jvm.suspend_count_checks(), 1);   // một lần cho cả batch
    // reply i khớp lệnh i (JVM giả trả body = id lệnh)
}
#[tokio::test] async fn batch_waits_for_adapter_invoke() {
    // adapter gửi InvokeMethod (9/6) sau lệnh thứ 3; JVM giả trả lời invoke sau 200 ms
    // assert: không lệnh nào của link được ghi khi invoke còn chờ; batch xong Ok;
    // reply.adapter_ran == true; SuspendCount được kiểm lại sau invoke (checks == 2)
}
#[tokio::test] async fn batch_stale_when_vm_resumes() { /* adapter gửi Resume giữa batch → Err(LinkError::Stale) */ }
#[tokio::test] async fn batch_counts_ids_of_every_reply() {
    // ReplyIds::Objects (AllThreads, 3 id) + ReplyIds::TaggedObject (ThisObject, 1 id);
    // sau Resume của adapter: DisposeObjects chứa đúng 4 id, mỗi id refcount 1
}
#[tokio::test] async fn batch_per_command_jdwp_error() { /* lệnh 2 trả lỗi 20 → replies[2] == Err(Jdwp(20)), các lệnh khác Ok */ }
```

Thêm vào test của `ids.rs`: `object_ids(ReplyIds::Objects, …)` trên `00 00 00 02 | id1 | id2` cho `[id1, id2]`; `TaggedObject` trên `'L' | id` cho `[id]` và trên `'L' | 0` cho `[]`.

- [ ] **Step 2: Chạy, kỳ vọng FAIL** (chưa có `batch`, `ReplyIds::Objects`): `cargo nextest run -p ide-jdwp batch ids`

- [ ] **Step 3: Cài đặt.**
  - Lấy turn một lần.
  - Kiểm `SuspendCount` theo quy tắc của `command()` (5 lần, cách 100 ms).
  - Rồi ghi lệnh khi số lệnh đang bay `< BATCH_WINDOW`. Trước mỗi lần ghi: generation phải còn khớp, nếu không thì `Stale`. Nếu `core.invokes` không rỗng thì đặt `adapter_ran = true`, chờ `invokes` rỗng (dùng `Notify` của shared state), rồi kiểm lại `SuspendCount` một lần.
  - Ledger đếm id của mọi reply về, kể cả khi caller đã bỏ.
  - Id lệnh lấy từ dải riêng như `command()`.
  - Không đổi `command()`.

- [ ] **Step 4: Chạy, kỳ vọng PASS**: `cargo nextest run -p ide-jdwp`

- [ ] **Step 5: Commit**

```bash
git add crates/ide-jdwp/src/link/batch.rs crates/ide-jdwp/src/link/batch_tests.rs crates/ide-jdwp/src/link/mod.rs crates/ide-jdwp/src/link/state.rs crates/ide-jdwp/src/ids.rs crates/ide-jdwp/src/lib.rs
git commit -m "feat(debugger): pipeline the JDWP link's short commands within one stop"
```

### Task 2: `JvmInspector::read` và cách `LinkInspector` cài nó

**Files:**

- Create: `crates/ide-jvm-inspect/src/read.rs`, `crates/ide-jdwp/src/inspector/read.rs`, `crates/ide-jdwp/src/inspector/threads.rs`, `crates/ide-jdwp/src/inspector/read_tests.rs`
- Modify: `crates/ide-jvm-inspect/src/lib.rs`, `crates/ide-jdwp/src/inspector.rs`, `crates/ide-jdwp/src/inspector/wire.rs`, `crates/ide-jdwp/src/inspector/fake.rs`, `crates/ide-jdwp/src/inspector/cache.rs`

**Interfaces:**

- Consumes: Task 1 `JdwpLink::batch`, `BatchCommand`, `BatchReply`; `Caches` của M2 (names, fields, superclasses theo generation).
- Produces (`ide-jvm-inspect::read`, re-export ở gốc crate):

```rust
pub enum Read {
    /// ReferenceType của object, rồi GetValues các field instance (cả lớp cha); mỗi phần tử
    /// của `fields` là danh sách tên thay thế, lấy tên đầu tiên class có.
    Fields { object: ObjectId, fields: Vec<&'static [&'static str]> },
    Static { class: String, field: &'static str },
    Text { string: ObjectId },
    Elements { array: ObjectId, max: u32 },
    /// AllThreads + Name + Frames(0, -1); `this` chỉ đọc cho frame có tên method trong `this_for`.
    Threads { this_for: &'static [&'static str] },
    /// Mọi class đã nạp có `ancestor` trong chuỗi lớp cha (cả chính nó), theo tên.
    Subclasses { ancestor_suffix: String },
    Instances { class: String, limit: u32 },
    Counts { classes: Vec<String> },
    ClassPaths,
}
pub enum Answer {
    Fields { class: Arc<ClassChain>, values: Vec<Option<RawValue>> }, // None: class không có field đó
    Static(Option<RawValue>),
    Text(String),
    Elements(Vec<RawValue>),
    Threads(Vec<ThreadStack>),
    Subclasses(Vec<Arc<ClassChain>>),
    Instances(Vec<ObjectId>),
    Counts(Vec<u64>),
    ClassPaths { base: String, entries: Vec<String> },
}
pub struct ClassChain { pub name: String, pub supers: Vec<String> } // supers: lớp cha gần nhất trước, tới java.lang.Object
pub enum RawValue { Null, Bool(bool), Int(i64), Float(f64), Char(u16), Object(ObjectId) }
pub struct ThreadStack { pub id: ObjectId, pub name: String, pub frames: Vec<ThreadFrame> }
pub struct ThreadFrame { pub class: String, pub method: String, pub file: Option<String>, pub line: Option<u32>, pub this: Option<ObjectId> }

pub trait JvmInspector { /* có sẵn */
    /// Một đợt đọc độc lập; lỗi từng mục (`Collected`, `ClassNotLoaded`) ở phần tử của nó.
    fn read<'a>(&'a self, target: &'a VmTarget, batch: Vec<Read>) -> InspectFuture<'a, Vec<Result<Answer, InspectError>>> {
        Box::pin(async { Err(InspectError::Unsupported("read".into())) })
    }
    fn reads(&self) -> bool { false }
}
```

- [ ] **Step 1: Viết test thất bại** trong `read_tests.rs`, dùng `fake.rs` mở rộng: thread có frame, static, chuỗi, `ClassPaths`, method có `LineTable`, `SourceFile`.

```rust
#[tokio::test] async fn fields_resolve_aliases_and_superclass_fields() {
    // class StandaloneCoroutine extends JobSupport{_state$volatile}; Read::Fields{ fields: [&["_state$volatile","_state"], &["missing"]] }
    // assert values == [Some(RawValue::Object(7)), None]; class.supers[0] == "kotlinx.coroutines.AbstractCoroutine"
}
#[tokio::test] async fn fields_batch_uses_one_reference_type_per_object_and_caches_class_layout() {
    // 50 object cùng class: số lệnh ReferenceType (9/1) == 50, Fields (2/4) == 1 mỗi class trong chuỗi, GetValues (9/2) == 50
}
#[tokio::test] async fn threads_read_frames_lines_and_this() {
    // thread "main" có 3 frame; frame 2 là invokeSuspend: this == Some(id), các frame khác None; line từ LineTable; file từ SourceFile
}
#[tokio::test] async fn threads_retry_after_adapter_ran() {
    // fake báo adapter invoke giữa chừng, frame trả INVALID_FRAMEID một lần → Threads đọc lại một lần → Ok
}
#[tokio::test] async fn subclasses_and_counts() { /* Subclasses{ancestor_suffix: "kotlinx/coroutines/JobSupport;"} trả đúng 3 class; Counts theo thứ tự */ }
#[tokio::test] async fn collected_object_is_per_item_error() { /* Fields trên id đã GC → Err(Collected) ở phần tử đó, phần tử khác Ok */ }
#[tokio::test] async fn link_inspector_reads() { assert!(LinkInspector::new(link).reads()); }
```

- [ ] **Step 2: Chạy, kỳ vọng FAIL**: `cargo nextest run -p ide-jdwp inspector::read_tests`

- [ ] **Step 3: Cài đặt** `LinkInspector::read`. Mỗi đợt gom các `Read` cùng loại thành đợt con và gửi qua `batch` (`COMMAND_TIMEOUT`). `Fields` cần hai đợt con: ReferenceType cho mọi object, rồi các lệnh layout còn thiếu trong cache (Signature 2/1, Superclass 3/1, Fields 2/4), rồi GetValues cho mọi object. `Threads`:
  - Đợt con 1: AllThreads (1/4, `Objects`).
  - Đợt con 2: Name (11/1) và Frames (11/6) mọi thread.
  - Đợt con 3: tên method (Methods 2/5, cache theo class), LineTable (6/1, cache theo method), SourceFile (2/7), và ThisObject (16/3, `TaggedObject`) cho frame có method trong `this_for`.

  Gặp `adapter_ran` hoặc lỗi 30 thì đọc lại `Threads` một lần. `Instances`/`Counts` đi qua `call`/`call_within(COUNTS_TIMEOUT)` có sẵn, mỗi lệnh một lần. `Subclasses` dùng `all_classes` + chuỗi superclass trong cache. `ClassPaths` (1/13) không có id. Bảng `map_link_error` dùng như M2.

- [ ] **Step 4: Chạy, kỳ vọng PASS**: `cargo nextest run -p ide-jdwp -p ide-jvm-inspect`

- [ ] **Step 5: Commit**

```bash
git add crates/ide-jvm-inspect/src/read.rs crates/ide-jvm-inspect/src/lib.rs crates/ide-jdwp/src/inspector.rs crates/ide-jdwp/src/inspector/read.rs crates/ide-jdwp/src/inspector/threads.rs crates/ide-jdwp/src/inspector/wire.rs crates/ide-jdwp/src/inspector/fake.rs crates/ide-jdwp/src/inspector/cache.rs crates/ide-jdwp/src/inspector/read_tests.rs
git commit -m "feat(debugger): read JVM fields, threads and classes in batches over the JDWP link"
```

### Task 3: `@DebugMetadata` từ bytes `.class` và tìm `.class` qua classpath

**Files:**

- Create: `crates/ide-jvm-inspect/src/coroutines/mod.rs`, `coroutines/metadata.rs`, `coroutines/classpath.rs`, `crates/ide-jvm-inspect/tests/data/README.md`, `crates/ide-jvm-inspect/tests/data/MainKt$level2$1.class`, `crates/ide-jvm-inspect/tests/data/probe-classes.jar`, fixture `fixtures/kotlin-coroutines/{settings.gradle.kts,build.gradle.kts,src/main/kotlin/probe/Main.kt}` (đủ các trường hợp ở bảng của Task 7)
- Modify: `crates/ide-jvm-inspect/Cargo.toml` (`zip.workspace = true`), `crates/ide-jvm-inspect/src/lib.rs` (`pub mod coroutines;`), `fixtures/README.md` (một dòng: JDK 21, Gradle 8 no wrapper, `gradle installDist`, `gradle run`)

**Interfaces:**

- Produces:

```rust
pub struct DebugMetadata {
    pub version: i32,               // v
    pub file: Option<String>,       // f ("" → None)
    pub lines: Vec<i32>,            // l
    pub method: Option<String>,     // m
    pub class: Option<String>,      // c, dạng dấu chấm
    pub spilled: Vec<String>,       // s
    pub names: Vec<String>,         // n
}
pub fn debug_metadata(class_file: &[u8]) -> Result<Option<DebugMetadata>, ClassFileError>;
impl DebugMetadata { pub fn line_for_label(&self, label: i32) -> Option<u32>; } // l[label-1]

pub trait ClassBytes: Send + Sync { fn class_bytes(&self, binary_name: &str) -> Option<Arc<[u8]>>; }
pub struct ClassPathIndex { /* thư mục và jar; cache bytes theo tên */ }
impl ClassPathIndex {
    /// `base` + `entries` của `Answer::ClassPaths`; mục tương đối được ghép với `base`. Mục không tồn tại bị bỏ qua.
    pub fn new(base: &str, entries: &[String]) -> Self;
}
impl ClassBytes for ClassPathIndex {}
```

- [ ] **Step 1: Viết fixture rồi test thất bại**. Viết fixture theo bảng của Task 7. Tạo dữ liệu test từ fixture, lệnh tái tạo ghi trong `tests/data/README.md`: `gradle -p fixtures/kotlin-coroutines classes`, rồi copy `build/classes/kotlin/main/probe/MainKt$level2$1.class` và `jar cf probe-classes.jar -C build/classes/kotlin/main probe`.

```rust
#[test] fn reads_debug_metadata_of_suspend_lambda() {
    let m = debug_metadata(include_bytes!("../../tests/data/MainKt$level2$1.class")).unwrap().unwrap();
    assert_eq!(m.file.as_deref(), Some("Main.kt")); assert_eq!(m.method.as_deref(), Some("level2"));
    assert_eq!(m.class.as_deref(), Some("probe.MainKt")); assert_eq!(m.line_for_label(1), Some(m.lines[0] as u32));
    assert_eq!(m.line_for_label(0), None); assert_eq!(m.line_for_label(99), None);
}
#[test] fn class_without_annotation_is_none() { /* bytes của một class Java nhỏ dựng tay → Ok(None) */ }
#[test] fn truncated_class_file_is_error() { /* cắt bytes còn 40 → Err(_), không panic */ }
#[test] fn finds_class_in_directory_and_jar() {
    // ClassPathIndex::new(tmp, ["classes", "probe-classes.jar", "missing.jar"]);
    // class_bytes("probe.MainKt$level2$1") Some ở cả thư mục và jar; class_bytes("x.Y") None
}
#[test] fn relative_entries_join_base() { /* base=/tmp/a, entry "build/classes" → đọc /tmp/a/build/classes */ }
```

- [ ] **Step 2: Chạy, kỳ vọng FAIL**: `cargo nextest run -p ide-jvm-inspect coroutines::metadata coroutines::classpath`

- [ ] **Step 3: Cài đặt.** Parser constant pool theo JVMS §4.4: tag 5 và 6 chiếm hai ô. Bỏ qua field và method, đọc `RuntimeVisibleAnnotations` của class, tìm `Lkotlin/coroutines/jvm/internal/DebugMetadata;`. Giá trị phần tử: `I` qua `CONSTANT_Integer`, `s` qua Utf8, `[` là mảng. Jar đọc bằng `zip` (mở lại theo đường dẫn, cache `Arc<[u8]>` theo tên). Không đọc jar lồng (quyết định 7).

- [ ] **Step 4: Chạy, kỳ vọng PASS**: lệnh ở Step 2.

- [ ] **Step 5: Commit**

```bash
git add crates/ide-jvm-inspect/Cargo.toml crates/ide-jvm-inspect/src/lib.rs crates/ide-jvm-inspect/src/coroutines/mod.rs crates/ide-jvm-inspect/src/coroutines/metadata.rs crates/ide-jvm-inspect/src/coroutines/classpath.rs crates/ide-jvm-inspect/tests/data/README.md "crates/ide-jvm-inspect/tests/data/MainKt\$level2\$1.class" crates/ide-jvm-inspect/tests/data/probe-classes.jar Cargo.lock fixtures/kotlin-coroutines/settings.gradle.kts fixtures/kotlin-coroutines/build.gradle.kts fixtures/kotlin-coroutines/src/main/kotlin/probe/Main.kt fixtures/README.md
git commit -m "feat(debugger): read coroutine debug metadata from the debuggee's class files"
```

### Task 4: Model và đi đồ thị (nguồn Graph, chưa có kiểm khoảng hở)

**Files:**

- Create: `crates/ide-jvm-inspect/src/coroutines/model.rs`, `coroutines/walk.rs`, `coroutines/state.rs`, `coroutines/fake_heap.rs` (`#[cfg(test)]`), `coroutines/walk_tests.rs`
- Modify: `crates/ide-jvm-inspect/src/coroutines/mod.rs`

**Interfaces:**

- Consumes: Task 2 `Read`/`Answer`/`JvmInspector::read`; Task 3 `ClassBytes`, `debug_metadata`.
- Produces (serde camelCase + `specta::Type`, kiểu enum có tag `kind`, như `JvmValue`):

```rust
pub struct CoroutineSnapshot {
    pub source: CoroutineSource,   // Agent | Graph
    /// Mọi coroutine đang sống đều có trong danh sách (registry, hoặc kiểm khoảng hở không thấy thiếu).
    pub complete: bool,
    pub truncated: bool,           // chạm MAX_COROUTINES
    /// Số coroutine đếm được mà không tìm thấy; 0 khi complete hoặc chưa kiểm.
    pub unaccounted: u64,
    pub coroutines: Vec<CoroutineInfo>,
}
pub struct CoroutineInfo {
    pub key: ObjectId, pub kind: CoroutineKind /* Coroutine | Job */, pub class_name: String,
    pub name: Option<String>, pub debug_id: Option<i64>, pub job: JobState, pub exec: ExecState,
    pub dispatcher: Option<String>, pub parent: Option<ObjectId>, pub children: Vec<ObjectId>,
    pub frames: Vec<CoroutineFrame>, pub missing: Vec<Missing>,
}
pub enum JobState { New, Active, Completing, Cancelling, Cancelled, Completed }
pub enum ExecState { Running { thread: CoroutineThread }, Suspended, Created, Unknown }
pub struct CoroutineThread { pub id: ObjectId, pub name: String }
pub struct CoroutineFrame { pub origin: FrameOrigin /* Thread | Async | Creation */, pub class_name: String,
    pub method: String, pub file: Option<String>, pub line: Option<u32> }
pub enum Missing { Frames, Metadata, CreationStack }
pub struct SnapshotOptions { pub gap_check: bool, pub deep_frames: bool }
pub const MAX_COROUTINES: usize = 20_000; pub const MAX_ASYNC_FRAMES: usize = 256; pub const MAX_NODE_LIST: usize = 100_000;
/// `Ok(None)`: debuggee chưa nạp kotlinx-coroutines (không có class kết thúc bằng `kotlinx/coroutines/JobSupport;`).
pub async fn snapshot(inspector: &dyn JvmInspector, target: &VmTarget, classes: &dyn ClassBytes,
    options: SnapshotOptions) -> Result<Option<CoroutineSnapshot>, InspectError>;
```

Quy tắc giải mã (G1/G6). `P` là tiền tố gói dò được, `S` là tiền tố của stdlib dò theo hậu tố `kotlin/coroutines/jvm/internal/BaseContinuationImpl;`.

| Khái niệm                | Quy tắc                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coroutine                | class con của `P.AbstractCoroutine`, trừ class con của `P.internal.ScopeCoroutine`                                                                                                                                                                                                                               |
| Job thường (`kind: Job`) | class con của `P.JobSupport` nhưng không phải `AbstractCoroutine` (`JobImpl`, `SupervisorJobImpl`, `CompletableDeferredImpl`): chỉ hiện trong cây job                                                                                                                                                            |
| Continuation             | class con **thực sự** của `S.BaseContinuationImpl`; template (`completion == null` hoặc `label == 0` mà không chạy trên thread nào) bị lọc; `P.flow.internal.SafeCollector` và builder `sequence{}`/`iterator{}` (`kotlin.sequences.SequenceBuilderIterator`) bị lọc                                             |
| Chủ của continuation     | đi `completion` tới object không phải continuation; gặp `…DebugProbesImpl$CoroutineOwner` thì đi tiếp `delegate`; gặp `ScopeCoroutine` thì frame đi tiếp qua `uCont` → chuỗi `completion` của nó, và chủ là coroutine bao ngoài                                                                                  |
| Gốc                      | (1) `Threads{this_for: ["invokeSuspend"]}`: frame `invokeSuspend` trong cùng của mỗi thread → `this` → chủ, `exec = Running`; (2) `Static{P.DefaultExecutor, "INSTANCE"}` và `eventLoop` của mỗi `BlockingCoroutine` → `_delayed` → `a[]` → `DelayedResumeTask.cont`                                             |
| Cha / con                | `_parentHandle` → `ChildHandleNode.job`; danh sách nút từ `_state`: `NodeList`/`InactiveNodeList` (đi `_next`), `JobSupport$Finishing.list`, một `JobNode`; nút `ChildHandleNode.childJob` là con; nút `ChildContinuation.child` (CCI) → `delegate` (bỏ lớp `DispatchedContinuation` qua `continuation`) là leaf |
| Trạng thái job           | `Empty{isActive=false}`/`InactiveNodeList` → New; `Empty{true}`/`NodeList`/`JobNode` → Active; `Finishing` có `_rootCause` → Cancelling, `_isCompleting` → Completing, còn lại Active; `CompletedExceptionally` (gồm `CancelledContinuation`) → Cancelled; còn lại → Completed                                   |
| exec                     | Running (thấy trên thread); Created (job New); Suspended (có leaf); còn lại Unknown, kèm `missing: Frames`                                                                                                                                                                                                       |
| Tên, id, dispatcher      | `context` → đệ quy `CombinedContext.left/element`; `P.CoroutineName.name` (Text); `P.CoroutineId.id`; phần tử là class con của `P.CoroutineDispatcher` → `dispatcher` = tên đơn giản của class                                                                                                                   |
| Frame                    | Thread: frame thread từ đỉnh tới `invokeSuspend` trong cùng. Async: mỗi continuation → metadata (`c`, `m`, `f`, `line_for_label(label)`). Không có metadata thì class = tên class tới `$` đầu, method = đoạn sau (`probe.MainKt$level2$1` → `probe.MainKt.level2`), `missing: Metadata`                          |

- [ ] **Step 1: Viết test thất bại** (`walk_tests.rs`). `FakeHeap` cài `JvmInspector::read` trên một đồ thị dựng bằng builder: `heap.class(name, supers)`, `heap.obj(class, &[(field, RawValue)])`, `heap.thread(name, frames)`, `heap.static(class, field, value)`. Dựng các ca trong một heap kiểu fixture anchored, chạy với `futures::executor::block_on`:

```rust
#[test] fn finds_running_suspended_and_children() {
    // root BlockingCoroutine trên thread main (invokeSuspend this → lambda → completion = root)
    // con "suspended-deep": ChildHandleNode trong NodeList của root; leaf qua ChildContinuation→CCI→DispatchedContinuation
    // assert names == {"root","suspended-deep"}; root.exec == Running{thread.name=="main"}; deep.exec == Suspended
    // deep.parent == Some(root.key); root.children == [deep.key]
    // ClassBytes giả trả bytes tests/data cho "probe.MainKt$level2$1"; leaf label = 1
    // deep.frames[0] == Async{class "probe.MainKt", method "level2", file "Main.kt", line: metadata.line_for_label(1)}
    // frame sau đó là continuation không có bytes → class/method suy từ tên, missing chứa Metadata
}
#[test] fn delay_queue_is_a_root() { /* GlobalScope coroutine chỉ đến được qua DefaultExecutor._delayed → found */ }
#[test] fn scope_coroutine_merges_into_owner() {
    // with-context → DispatchedCoroutine(inner-ctx) → leaf; chỉ "with-context" là kind Coroutine
    // frames của nó gồm leaf trong withContext rồi lambda ngoài qua uCont; không có CoroutineInfo cho DispatchedCoroutine
}
#[test] fn job_states() { /* Finishing có _rootCause → Cancelling; Empty(false) → New + exec Created; CompletedExceptionally → Cancelled */ }
#[test] fn field_aliases_old_and_new() { /* cùng đồ thị với "_state" thay "_state$volatile" → kết quả bằng nhau */ }
#[test] fn templates_and_safe_collector_filtered() { /* lambda completion==null; SafeCollector trong chuỗi → không thành frame/coroutine */ }
#[test] fn raw_suspend_coroutine_marks_missing_frames() { /* job Active, state Empty, không thread → exec Unknown, missing == [Frames] */ }
#[test] fn frame_without_metadata_uses_class_name() { /* ClassBytes rỗng → frame "probe.MainKt"."level2", missing chứa Metadata */ }
#[test] fn not_loaded_returns_none() { /* không class JobSupport → Ok(None) */ }
#[test] fn shaded_prefix() { /* class "com.x.shaded.kotlinx.coroutines.StandaloneCoroutine" → found */ }
#[test] fn unknown_layout_degrades() { /* StandaloneCoroutine (tìm qua thread) không có _state lẫn _state$volatile → vẫn liệt kê; job == Active; exec == Running; frame Thread có; missing không chứa Frames; không Err */ }
#[test] fn cycle_and_limits() { /* chuỗi completion vòng → dừng ở MAX_ASYNC_FRAMES; > MAX_COROUTINES → truncated */ }
```

`unknown_layout_degrades` chốt: thiếu field trạng thái thì `job = Active`, không đi được xuống con; phần còn lại giải mã như thường.

- [ ] **Step 2: Chạy, kỳ vọng FAIL**: `cargo nextest run -p ide-jvm-inspect coroutines::walk_tests`

- [ ] **Step 3: Cài đặt** `snapshot` (khi `gap_check == false`) theo bảng.
  - Đi theo đợt (mỗi đợt một `read`). Object đã thăm giữ trong `HashSet`.
  - Mỗi object đọc `Fields` một lần, với mọi tên field cần cho class của nó: lần đầu dùng hợp mọi tên, lần sau dùng theo class đã biết.
  - Xác định class nào là class con dựa vào `Answer::Fields.class.supers`, không cần lệnh thêm.
  - Đọc metadata của mỗi class continuation một lần.

- [ ] **Step 4: Chạy, kỳ vọng PASS**: lệnh ở Step 2.

- [ ] **Step 5: Commit**

```bash
git add crates/ide-jvm-inspect/src/coroutines/mod.rs crates/ide-jvm-inspect/src/coroutines/model.rs crates/ide-jvm-inspect/src/coroutines/walk.rs crates/ide-jvm-inspect/src/coroutines/state.rs crates/ide-jvm-inspect/src/coroutines/fake_heap.rs crates/ide-jvm-inspect/src/coroutines/walk_tests.rs
git commit -m "feat(debugger): build the coroutine tree from a suspended JVM's heap"
```

### Task 5: Kiểm khoảng hở, Deep scan frame, và registry của agent

**Files:**

- Create: `crates/ide-jvm-inspect/src/coroutines/gap.rs`, `coroutines/registry.rs`, `coroutines/gap_tests.rs`
- Modify: `crates/ide-jvm-inspect/src/coroutines/{mod.rs,walk.rs,fake_heap.rs}`

**Interfaces:**

- Consumes: Task 4 `snapshot`, `SnapshotOptions`, model.
- Produces: `SnapshotOptions { gap_check, deep_frames }` có tác dụng; `CoroutineSnapshot.complete/unaccounted/source` được điền.

Quy tắc:

- **Kiểm khoảng hở** (`gap_check`):
  - `Subclasses{P.AbstractCoroutine}`, bỏ class con của ScopeCoroutine.
  - Rồi `Counts` trên các class đó.
  - Class nào đếm > số đã tìm thì `Instances{class, limit: MAX_COROUTINES}`. Instance mới thành gốc; đi đồ thị tiếp (cha, con, leaf).
  - Kết quả: `complete = (sau bổ sung, mọi class: đếm == tìm)`, `unaccounted = Σ(đếm − tìm)`.
  - Job đã xong mà còn được tham chiếu cũng được tính và liệt kê với job Completed/Cancelled.
- **Deep frame** (`deep_frames`): chỉ khi có coroutine `missing: Frames`.
  - `Subclasses{S.BaseContinuationImpl}` → `Counts` → `Instances` các class khác 0.
  - Continuation không phải `completion` của continuation khác là leaf. Leaf có chủ thuộc nhóm thiếu frame thì dựng frame và bỏ `Frames` khỏi `missing`.
- **Registry**:
  - Khi `Static{P.debug.internal.DebugProbesImpl, "capturedCoroutinesMap"}` khác null, đi theo §9: `core → keys (AtomicReferenceArray.array) → HashedWeakRef.referent → CoroutineOwner{delegate, info}`.
  - Coroutine = `delegate`, `debug_id = info.sequenceNumber`.
  - Creation frame: `info.creationStackBottom` → chuỗi `StackTraceFrame{callerFrame, stackTraceElement}` → các field `declaringClass`, `methodName`, `fileName`, `lineNumber` của `StackTraceElement`, origin Creation.
  - `source = Agent`, `complete = true`, bỏ qua kiểm khoảng hở.
  - Cây, trạng thái, frame async vẫn theo Task 4.
  - Không có registry: mọi coroutine có `missing` chứa `CreationStack`.

- [ ] **Step 1: Viết test thất bại** (`gap_tests.rs`):

```rust
#[test] fn gap_check_finds_unanchored_scope() {
    // SupervisorJobImpl + 6 StandaloneCoroutine (chan/await/raw/mutex/parent/child), không thread, không delay (G6)
    // gap_check=false → coroutines rỗng, complete=false
    // gap_check=true  → đủ 6 Coroutine + 1 Job; complete=true; unaccounted=0; Instances chỉ gọi cho StandaloneCoroutine
}
#[test] fn gap_check_skips_instances_when_counts_match() { /* đồ thị anchored đủ → không lệnh Instances nào */ }
#[test] fn gap_counts_completed_but_referenced() { /* Deferred đã xong được user giữ → liệt kê với job Completed, complete=true */ }
#[test] fn deep_frames_recovers_raw_suspend() { /* raw-suspend: missing [Frames] → deep_frames=true → frames Async rawWait, missing không còn Frames */ }
#[test] fn registry_source_and_creation_stack() {
    // DebugProbesImpl static + 2 CoroutineOwner; assert source==Agent, complete==true, debug_id==Some(seq), frames có origin Creation
}
#[test] fn no_agent_marks_creation_missing() { /* mọi coroutine missing chứa CreationStack */ }
```

- [ ] **Step 2: Chạy, kỳ vọng FAIL**: `cargo nextest run -p ide-jvm-inspect coroutines::gap_tests`
- [ ] **Step 3: Cài đặt** theo quy tắc trên.
- [ ] **Step 4: Chạy, kỳ vọng PASS**: `cargo nextest run -p ide-jvm-inspect`
- [ ] **Step 5: Commit**

```bash
git add crates/ide-jvm-inspect/src/coroutines/gap.rs crates/ide-jvm-inspect/src/coroutines/registry.rs crates/ide-jvm-inspect/src/coroutines/gap_tests.rs crates/ide-jvm-inspect/src/coroutines/mod.rs crates/ide-jvm-inspect/src/coroutines/walk.rs crates/ide-jvm-inspect/src/coroutines/fake_heap.rs
git commit -m "feat(debugger): find coroutines no thread or delay leads to, and read the agent's registry"
```

### Task 6: Nối vào phiên: capability, `DebugManager::jvm_coroutines`, IPC

**Files:**

- Create: `crates/ide-dap/src/jvm_memory/coroutines.rs`
- Modify: `crates/ide-dap/src/jvm_memory/mod.rs`, `crates/ide-dap/src/lib.rs` (`DebugCapabilities` dòng 118–136, `caps` ~1572, method mới cạnh `jvm_memory_referrers` ~1615), `crates/ide-dap/src/session.rs` (field `coroutine_classes`, `coroutine_gap_ms`), `crates/ide-dap/src/jvm_memory/tests.rs`, `crates/ide-host/src/ops/debug.rs` (hàm + `register` ~588), `src-tauri/src/commands/debug.rs`, `src-tauri/src/commands/mod.rs:461`, `src/bindings.ts` (sinh lại)

**Interfaces:**

- Consumes: Task 5 `snapshot`; M2 `vm_target`, `Call::begin/run/finish`, `settle`, `inspect_lock`, `JvmInspectUnavailable`.
- Produces:

```rust
pub struct DebugCapabilities { /* có sẵn */ pub jvm_coroutines: bool }  // = jvm_inspector có và inspector.reads()
pub enum CoroutineRefresh { Auto, Full, DeepFrames }   // serde camelCase
pub enum JvmCoroutinesResult {                          // tag "status", như JvmInstancesResult
    Ready { generation: u64, snapshot: CoroutineSnapshot },
    NotUsed,
    Unavailable { reason: JvmInspectUnavailable },
}
impl DebugManager { pub async fn jvm_coroutines(&self, s: DebugSessionId, refresh: CoroutineRefresh) -> IdeResult<JvmCoroutinesResult>; }
// ide-host/src/ops/debug.rs
pub async fn debug_jvm_coroutines(host: &Host, window: &str, session: DebugSessionId, refresh: CoroutineRefresh) -> IdeResult<JvmCoroutinesResult>;
```

Ánh xạ `refresh`:

- `Auto`: `gap_check = coroutine_gap_ms ≤ 300`.
- `Full`: `gap_check = true`.
- `DeepFrames`: `gap_check = true, deep_frames = true`.

Thời gian đo của mỗi lần kiểm khoảng hở được lưu vào `coroutine_gap_ms`. `ClassPathIndex` dựng một lần mỗi phiên, từ `Read::ClassPaths` của lần gọi đầu, giữ trong `Session::coroutine_classes`. Giữ `inspect_lock` suốt snapshot.

- [ ] **Step 1: Viết test thất bại** (`jvm_memory/tests.rs`, inspector giả cài `read` bằng `FakeHeap` của Task 4. Nếu cần thì đưa `FakeHeap` ra sau feature `test-support` của `ide-jvm-inspect`):

```rust
#[tokio::test] async fn capability_follows_inspector_reads() { /* inspector reads()==true → caps.jvm_coroutines; M2 inspector không đè read → false */ }
#[tokio::test] async fn coroutines_ready_with_generation() { /* dừng, Full → Ready{generation == stop_seq, snapshot.coroutines.len()==2} */ }
#[tokio::test] async fn coroutines_not_used() { /* heap không có JobSupport → NotUsed */ }
#[tokio::test] async fn coroutines_stale_on_resume() { /* resume giữa read → Unavailable{Stale} */ }
#[tokio::test] async fn auto_skips_gap_check_after_slow_one() { /* coroutine_gap_ms = 900 → Auto không gọi Counts; complete == false */ }
#[tokio::test] async fn class_path_index_built_once() { /* hai lần gọi → Read::ClassPaths gửi 1 lần */ }
```

- [ ] **Step 2: Chạy, kỳ vọng FAIL**: `cargo nextest run -p ide-dap jvm_memory`
- [ ] **Step 3: Cài đặt** theo mẫu `inspect::instances` của M2. `InspectError` sang `JvmInspectUnavailable` qua bảng có sẵn. IPC như ba lệnh `debug_jvm_memory_*`: Tauri command `debug_jvm_coroutines(window, state, session, refresh)` gọi ops và đăng ký ở `mod.rs`. Rồi `pnpm gen:bindings`.
- [ ] **Step 4: Chạy, kỳ vọng PASS**: `cargo nextest run -p ide-dap -p ide-host`, rồi `pnpm typecheck`.
- [ ] **Step 5: Xác minh với fwcd** (chưa cần K1): `fixtures/kotlin-coroutines` (Task 3), Debug `Main.kt` dừng ở `pauseHere`, gọi `debug_jvm_coroutines` qua smoke host hoặc Tauri MCP → thấy 19 coroutine có tên. Lặp lại với kotlin-lsp khi đã có K1 Task 2.
- [ ] **Step 6: Commit**

```bash
git add crates/ide-dap/src/jvm_memory/coroutines.rs crates/ide-dap/src/jvm_memory/mod.rs crates/ide-dap/src/jvm_memory/tests.rs crates/ide-dap/src/lib.rs crates/ide-dap/src/session.rs crates/ide-host/src/ops/debug.rs src-tauri/src/commands/debug.rs src-tauri/src/commands/mod.rs src/bindings.ts
git commit -m "feat(debugger): expose a suspended Kotlin program's coroutines over IPC"
```

### Task 7: Test JVM thật trên fixture và ma trận phiên bản

**Files:**

- Create: `crates/ide-jdwp/tests/support/mod.rs`, `crates/ide-jdwp/tests/coroutines_real_jvm.rs`
- Modify: `crates/ide-jdwp/tests/real_jvm.rs` (dùng `support`)

**Interfaces:**

- Consumes: Task 5 `snapshot`, Task 2 `LinkInspector::read`, fixture của Task 3, adapter giả trong `real_jvm.rs` (chuyển sang `support`).
- Produces: bằng chứng độ phủ cho Task 11 và cho `verify`. Ngắt ở `probe.MainKt.pauseHere`.

Fixture (viết ở Task 3): Kotlin 2.0.21, `kotlinx-coroutines-core:1.9.0`, `jvmToolchain(21)`, `application { mainClass = "probe.MainKt" }`. Thuộc tính hệ thống: `-Dnoselect` bỏ ca select, `-Dunanchored` chạy nhánh scope riêng, `-Dmany=N`.

| Tên coroutine                                                                       | Dựng bằng                                                               | Kỳ vọng (gap_check)                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `root`                                                                              | `runBlocking(CoroutineName("root"))`                                    | Running trên `main`                                    |
| `suspended-deep`                                                                    | `launch { level1("deep") }`, `level2` gọi `delay`                       | Suspended, frame `level2`, `level1` có dòng            |
| `cpu-running`                                                                       | `Dispatchers.Default`, vòng `spin`                                      | Running trên `DefaultDispatcher-worker-*`              |
| `io-blocked`                                                                        | `Dispatchers.IO` + `withContext(IO) { Thread.sleep }`                   | Running, frame thread `Thread.sleep`                   |
| `chan-sender`                                                                       | `ch.send(42)` không người nhận                                          | Suspended                                              |
| `flow-collector`                                                                    | `flow { emit; delay }.map{}.collect{}`                                  | Suspended, không frame `SafeCollector`                 |
| `with-context`                                                                      | `withContext(Default + CoroutineName("inner-ctx")) { delay }`           | một coroutine, frame qua `uCont`                       |
| `scope-parent`, `scope-child-a`, `scope-child-b`                                    | `coroutineScope { launch; async.await }`                                | con có parent là `scope-parent`                        |
| `lazy-never-started`                                                                | `start = LAZY`                                                          | job New, exec Created                                  |
| `cancelling`                                                                        | `finally { withContext(NonCancellable) { delay } }` rồi `cancel()`      | job Cancelling                                         |
| `raw-suspend`, `global-raw`                                                         | `suspendCoroutine { stash = it }`                                       | exec Unknown, `missing: Frames`; DeepFrames → có frame |
| `mutex-waiter`                                                                      | `Mutex(locked = true).lock()`                                           | Suspended                                              |
| `select-wait`                                                                       | `select { ch.onReceive {} }`                                            | Suspended                                              |
| `global-delay`, `global-parent`/`global-child`                                      | `GlobalScope.launch`                                                    | tìm thấy, cha/con đúng                                 |
| `-Dunanchored`: `u-chan`, `u-await`, `u-raw`, `u-mutex`, `u-parent`, `u-child-chan` | `CoroutineScope(SupervisorJob() + Default)`, main không trong coroutine | đủ 6 khi gap_check, 0 khi tắt                          |

- [ ] **Step 1: Viết test** (`coroutines_real_jvm.rs`, mọi test `#[ignore]`):
  - Env: `OPENIDEA_TEST_JAVA`, và `OPENIDEA_TEST_COROUTINES = fixtures/kotlin-coroutines/build/install/kotlin-coroutines/lib`.
  - Ma trận tuỳ chọn `OPENIDEA_TEST_COROUTINES_JARS = <thư mục chứa kotlinx-coroutines-core-jvm-<v>.jar>`: mỗi jar thay jar 1.9.0 trong classpath. Bản `<1.7` thêm `-Dnoselect=1`.

```rust
#[tokio::test] #[ignore] async fn anchored_fixture_matches_table() {
    // mọi tên trong bảng (trừ unanchored) có mặt; complete == true; trạng thái/exec như bảng
    // suspended-deep.frames[0] == Async{class "probe.MainKt", method "level2", file "Main.kt", line = dòng `delay` trong level2}
}
#[tokio::test] #[ignore] async fn unanchored_scope_found_by_gap_check() { /* -Dunanchored=1: gap off → 0; Full → 6 Coroutine */ }
#[tokio::test] #[ignore] async fn deep_frames_for_raw_suspend() { /* DeepFrames → raw-suspend có frame rawWait */ }
#[tokio::test] #[ignore] async fn agent_registry_matches_graph() {
    // fixture chạy với -javaagent:<kotlinx-coroutines-core-jvm-1.9.0.jar trên classpath> -Dkotlinx.coroutines.debug.enable.creation.stack.trace=true
    // source == Agent; tập tên == tập tên của nguồn Graph (Full) ở lần chạy không agent; suspended-deep có frame Creation
}
#[tokio::test] #[ignore] async fn version_matrix() { /* mỗi jar trong OPENIDEA_TEST_COROUTINES_JARS: anchored_fixture_matches_table */ }
#[tokio::test] #[ignore] async fn ten_thousand_coroutines_budget() { /* -Dmany=10000: Full < 6 s; 10_000 tên "m*" */ }
```

- [ ] **Step 2: Chạy, kỳ vọng FAIL lúc biên dịch** (chưa có `support`), rồi sửa `real_jvm.rs` dùng `support`: `cargo test -p ide-jdwp --tests --no-run`
- [ ] **Step 3: Dựng fixture và chạy**: `gradle -p fixtures/kotlin-coroutines installDist`, rồi `OPENIDEA_TEST_JAVA=$JAVA_HOME/bin/java OPENIDEA_TEST_COROUTINES=$PWD/fixtures/kotlin-coroutines/build/install/kotlin-coroutines/lib cargo test -p ide-jdwp --test coroutines_real_jvm -- --ignored`. Kỳ vọng PASS. Ghi thời gian của `ten_thousand_coroutines_budget` vào PR. Chạy thêm ma trận 1.5.2/1.6.4/1.7.3/1.8.1/1.9.0/1.10.2/1.11.0. Mọi JVM test mở phải dừng theo pid trong `Drop` của `support`. `cargo test -p ide-jdwp --test real_jvm -- --ignored` vẫn PASS.
- [ ] **Step 4: Commit**

```bash
git add crates/ide-jdwp/tests/support/mod.rs crates/ide-jdwp/tests/real_jvm.rs crates/ide-jdwp/tests/coroutines_real_jvm.rs
git commit -m "feat(debugger): check the coroutine view against real JVMs and coroutine versions"
```

### Task 8: Tab Coroutines

**Files:**

- Create: `src/features/debugger/coroutines/coroutinesState.ts`, `coroutinesTree.ts`, `CoroutinesView.tsx`, `CoroutinesView.module.css`, `jumpToFrame.ts`; tests `src/features/debugger/__tests__/coroutinesTree.test.ts`, `coroutinesState.test.ts`, `coroutinesView.test.tsx`
- Modify: `src/features/debugger/ui/DebugToolWindow.tsx` (`type Tab` dòng 107, `hasMemory` 163, mảng tab 186, view 242), `src/features/debugger/state.ts` (context `debugHasJvmCoroutines` cạnh dòng 360, làm mới khi dừng), `src/features/debugger/actions.ts` (cạnh `debug.memory.refresh` ~433), `src/ui/icons.tsx` (nếu thiếu icon), `src/platform/locales/text/{en,zh}.json`

**Interfaces:**

- Consumes: Task 6 `commands.debugJvmCoroutines(session, refresh)`, `JvmCoroutinesResult`, `CoroutineSnapshot`; `sessionSupports("jvmCoroutines", s)`; `commands.findFiles(query, limit)`; `editorService().openFile(path, options)`.
- Produces:

```ts
// coroutinesTree.ts
export function dispatcherLabel(className: string | null): string; // DefaultScheduler→"Dispatchers.Default"; DefaultIoScheduler, LimitingDispatcher→"Dispatchers.IO"; Unconfined→"Dispatchers.Unconfined"; BlockingEventLoop→"runBlocking"; null→"No dispatcher"; khác→className
export function groupByDispatcher(s: CoroutineSnapshot): { label: string; items: CoroutineInfo[] }[]; // chỉ kind Coroutine
export function jobTree(s: CoroutineSnapshot): JobNode[];   // gốc = không có parent trong snapshot; kind Job có mặt
/** DAP thread của một thread JDWP: `"name"@1,023 …` (kotlin-lsp) → khớp id bỏ dấu phẩy; khác thì id DAP == id JDWP; khác thì tên duy nhất. */
export function matchThread(t: CoroutineThread, threads: { id: number; name: string }[]): number | undefined;
export function currentCoroutine(s: CoroutineSnapshot, stoppedThreadId: number | null, threads: { id: number; name: string }[]): number | undefined; // key (ObjectId là number trong bindings)
// coroutinesState.ts
export function refreshCoroutines(sessionId: string, refresh: CoroutineRefresh): Promise<void>;
export const useCoroutines: /* zustand store: per session { status: "idle"|"loading"|"ready"|"notUsed"|"unavailable", generation, snapshot, reason } */;
// jumpToFrame.ts
export function jumpToFrame(frame: CoroutineFrame): Promise<boolean>; // findFiles(file) → đường dẫn kết thúc bằng gói/<file>; không thấy thì notify và false
```

Hành vi:

- **Tab:** hiện khi `sessionSupports("jvmCoroutines")`.
- **Làm mới tự động:** khi phiên dừng và tab đang mở thì gọi `Auto`. Khi resume thì xoá snapshot về trạng thái "Program is running". Kết quả mang generation cũ hơn lần dừng hiện tại thì bỏ.
- **Thanh công cụ:** Refresh (`Full`). Nút Deep scan chỉ hiện khi có coroutine `missing` chứa `frames`. Nút chuyển "Group by dispatcher" / "Job tree". Ô lọc theo tên, class hoặc text frame. Toggle "Show completed" (mặc định tắt, ẩn Completed/Cancelled). Nút Copy dump.
- **Banner:**
  - `complete == false && unaccounted > 0`: "{n} coroutines were not found. Refresh to look for them."
  - `complete == false`, chưa kiểm: "The list may be incomplete. Refresh to check."
  - `truncated`: "Showing the first {n} coroutines."
- **Ghim:** coroutine của thread đang dừng được ghim lên đầu, kèm nhãn "Current".
- **Dòng coroutine:** tên (hoặc class), `#debugId`, trạng thái exec, trạng thái job khi khác Active, dispatcher. Mở dòng ra thì thấy frame; frame Creation có tiêu đề "Creation stack". Nếu `missing` chứa `creationStack` thì hiện dòng mờ "Creation stack: enable “Capture coroutine creation stacks” in the run configuration". Bấm frame có file thì gọi `jumpToFrame`.
- **Danh sách dài:** dùng lại virtualization của Memory view (`InstancesPane`) nếu có. Không có thì giới hạn 500 dòng mỗi nhóm, kèm "Show more".
- **Trạng thái rỗng:** `notUsed` → "This program does not use kotlinx-coroutines". `unavailable` → lý do như Memory view; `timedOut` có Retry (Ruling M2).

- [ ] **Step 1: Viết test thất bại.**

```ts
test("matchThread reads kotlin-lsp names", () => {
  const threads = [{ id: 8, name: '"main"@1 in group "main": RUNNING' }, { id: 10, name: '"Attach Listener"@1,023: RUNNING' }];
  expect(matchThread({ id: 1, name: "main" }, threads)).toBe(8);
  expect(matchThread({ id: 1023, name: "Attach Listener" }, threads)).toBe(10);
  expect(matchThread({ id: 77, name: "worker" }, [{ id: 77, name: "worker" }])).toBe(77);
  expect(matchThread({ id: 5, name: "dup" }, [{ id: 1, name: "dup" }, { id: 2, name: "dup" }])).toBeUndefined();
});
test("groupByDispatcher hides jobs and labels dispatchers", () => { /* 3 coroutine + 1 Job → 2 nhóm "Dispatchers.Default", "runBlocking"; Job không có */ });
test("jobTree nests children and keeps plain jobs", () => { /* SupervisorJobImpl gốc với 2 con */ });
test("stale snapshot is dropped", async () => { /* trả lời generation 3 về sau khi đã dừng ở generation 4 → store không đổi */ });
test("refreshes on stop only while the tab is open", () => { /* tab memory → không gọi IPC; tab coroutines → gọi Auto */ });
test("view pins the current coroutine and shows banners", () => { /* render với snapshot fixture: dòng đầu là coroutine của thread dừng, nhãn "Current"; complete=false → banner */ });
test("deep scan button only when frames are missing", () => {});
```

- [ ] **Step 2: Chạy, kỳ vọng FAIL**: `pnpm vitest run src/features/debugger/__tests__/coroutinesTree.test.ts src/features/debugger/__tests__/coroutinesState.test.ts src/features/debugger/__tests__/coroutinesView.test.tsx`
- [ ] **Step 3: Cài đặt** theo Interfaces và hành vi ở trên. Action `debug.coroutines.refresh` (Full) và `debug.coroutines.deepScan` (DeepFrames), có `when` `debugHasJvmCoroutines`. Mọi chuỗi vào `en.json` + `zh.json`.
- [ ] **Step 4: Chạy, kỳ vọng PASS**: lệnh ở Step 2, rồi `pnpm vitest run src/platform/locales`, `pnpm typecheck`, `pnpm lint`.
- [ ] **Step 5: Commit**

```bash
git add src/features/debugger/coroutines/coroutinesState.ts src/features/debugger/coroutines/coroutinesTree.ts src/features/debugger/coroutines/CoroutinesView.tsx src/features/debugger/coroutines/CoroutinesView.module.css src/features/debugger/coroutines/jumpToFrame.ts src/features/debugger/__tests__/coroutinesTree.test.ts src/features/debugger/__tests__/coroutinesState.test.ts src/features/debugger/__tests__/coroutinesView.test.tsx src/features/debugger/ui/DebugToolWindow.tsx src/features/debugger/state.ts src/features/debugger/actions.ts src/platform/locales/text/en.json src/platform/locales/text/zh.json
git commit -m "feat(debugger): show a suspended Kotlin program's coroutines in the Debug tool window"
```

(Thêm `src/ui/icons.tsx` vào `git add` nếu có thêm icon.)

### Task 9: Dump coroutine

**Files:**

- Create: `src/features/debugger/coroutines/dump.ts`, `src/features/debugger/__tests__/coroutinesDump.test.ts`
- Modify: `src/features/debugger/actions.ts`, `src/features/debugger/coroutines/CoroutinesView.tsx`, `src/platform/locales/text/{en,zh}.json`

**Interfaces:**

- Consumes: Task 8 store + `dispatcherLabel`.
- Produces: `export function coroutineDump(s: CoroutineSnapshot): string;` và action `debug.coroutines.copyDump`. Action chép theo bộ lọc đang áp dụng, rồi báo "Coroutine dump copied".

Định dạng (cố định; `\t` là tab, mỗi coroutine cách nhau một dòng trống, chỉ `kind: coroutine`):

```
Coroutine dump: {n} coroutines[, {u} not found][, truncated]

"{name|class_name}"[ #{debugId}], state: {RUNNING|SUSPENDED|CREATED|UNKNOWN}[ on "{thread}"], job: {New|Active|Completing|Cancelling|Cancelled|Completed}, dispatcher: {label}
	at {class}.{method}({file}:{line})        ← "(Unknown Source)" khi thiếu file/line
	(Coroutine creation stack trace)          ← chỉ khi có frame Creation
	at …
```

- [ ] **Step 1: Viết test thất bại**: snapshot với 2 coroutine (một Running trên "main" có 2 frame Thread + 1 Async; một Suspended không file) → `expect(coroutineDump(s)).toBe(<chuỗi đầy đủ theo định dạng>)`; snapshot `unaccounted = 3` → dòng đầu `Coroutine dump: 2 coroutines, 3 not found`.
- [ ] **Step 2: Chạy, kỳ vọng FAIL**: `pnpm vitest run src/features/debugger/__tests__/coroutinesDump.test.ts`
- [ ] **Step 3: Cài đặt**; nút Copy dump của Task 8 gọi action.
- [ ] **Step 4: Chạy, kỳ vọng PASS**: lệnh ở Step 2 và `pnpm vitest run src/platform/locales`.
- [ ] **Step 5: Commit**

```bash
git add src/features/debugger/coroutines/dump.ts src/features/debugger/__tests__/coroutinesDump.test.ts src/features/debugger/actions.ts src/features/debugger/coroutines/CoroutinesView.tsx src/platform/locales/text/en.json src/platform/locales/text/zh.json
git commit -m "feat(debugger): copy a coroutine dump"
```

### Task 10: Tuỳ chọn "Capture coroutine creation stacks" cho Kotlin app do IDE chạy

**Files:**

- Modify: `src/features/run/jvmTypes.ts` (field cho loại Application), `src/features/debugger/java.ts` (`extraJson` của nhánh Kotlin, ~dòng 137–155), `crates/ide-dap/src/session.rs` (`start_kotlin_debuggee`, dòng 813), `crates/ide-dap/src/tests.rs` (hoặc test của session), `src/features/run/jvmTypes.test.ts`, `src/features/debugger/__tests__/java.test.ts`, `src/platform/locales/text/{en,zh}.json`

**Interfaces:**

- Consumes: `kotlin_jvm_args`, `classPaths` trong `args` của launch Kotlin.
- Produces:
  - Field `coroutineCreationStacks` (`control: "select"`, `"off"` mặc định / `"on"`, nhãn "Capture coroutine creation stacks", hint "Kotlin debug sessions; slows coroutines down").
  - `extraJson.captureCoroutineCreationStacks: boolean`.
  - `pub(crate) fn coroutine_agent_args(class_paths: &[String]) -> Option<[String; 2]>` trả `["-javaagent:<jar>", "-Dkotlinx.coroutines.debug.enable.creation.stack.trace=true"]`. Jar là mục đầu tiên của classpath có tên khớp `^kotlinx-coroutines-core(-jvm)?-\d[^/\\]*\.jar$` và chứa `kotlinx/coroutines/debug/internal/AgentPremain.class`. Spec §9: đúng jar đang trên classpath, không dùng `JAVA_TOOL_OPTIONS`.

- [ ] **Step 1: Viết test thất bại**:
  - Rust: `coroutine_agent_args` với jar tạm có entry `AgentPremain.class` → `Some`. Tên khớp mà không có entry → `None`. Không có jar → `None`.
  - `start_kotlin_debuggee` với `captureCoroutineCreationStacks: true`: hai đối số nằm trước `-agentlib:jdwp`. Không tìm thấy jar: phiên vẫn chạy, có một output `stderr` "Coroutine creation stacks are off: kotlinx-coroutines-core is not on the classpath.".
  - TS: config có `coroutineCreationStacks: "on"` → `extraJson.captureCoroutineCreationStacks === true`; mặc định `false`.
- [ ] **Step 2: Chạy, kỳ vọng FAIL**: `cargo nextest run -p ide-dap coroutine_agent`, `pnpm vitest run src/features/run/jvmTypes.test.ts src/features/debugger/__tests__/java.test.ts`
- [ ] **Step 3: Cài đặt.** Không áp dụng cho Gradle/Maven debug (quyết định 5).
- [ ] **Step 4: Chạy, kỳ vọng PASS**: lệnh ở Step 2. Rồi chạy tay fixture với tuỳ chọn bật: snapshot có `source: agent`, frame Creation.
- [ ] **Step 5: Commit**

```bash
git add src/features/run/jvmTypes.ts src/features/run/jvmTypes.test.ts src/features/debugger/java.ts src/features/debugger/__tests__/java.test.ts crates/ide-dap/src/session.rs crates/ide-dap/src/tests.rs src/platform/locales/text/en.json src/platform/locales/text/zh.json
git commit -m "feat(debugger): optionally capture coroutine creation stacks in Kotlin debug sessions"
```

### Task 11: Smoke và xác minh trong app

**Files:**

- Modify: `smoke/debug.test.ts` (ca `kotlin-coroutines`)

**Interfaces:**

- Consumes: Task 6 IPC qua `openidea-server`, Task 7 fixture, K1 Task 6 (smoke kotlin chạy bằng kotlin-lsp).

- [ ] **Step 1: Thêm ca smoke**: fixture `kotlin-coroutines`, breakpoint `pauseHere`. Sau lần dừng, gọi `debug_jvm_coroutines(session, "full")` → `status == "ready"`, có `suspended-deep` Suspended và `root` Running, `complete == true`. Khi chưa có K1, ca này chạy với fwcd; ghi rõ trong PR.
- [ ] **Step 2: Chạy**: `cargo build -p ide-host --bin openidea-server`, rồi `pnpm smoke smoke/debug.test.ts -t kotlin`. Kỳ vọng PASS.
- [ ] **Step 3: Xác minh trong app** bằng skill `verify` (Tauri MCP; `pnpm dev:status` để lấy cổng, truyền `appIdentifier`). Mở `fixtures/kotlin-coroutines` → Debug `Main.kt`, dừng ở `pauseHere`. Kiểm:
  - Tab Coroutines nhóm theo dispatcher, ghim `root` "Current".
  - Mở `suspended-deep` → bấm frame `level2` → editor mở `Main.kt` đúng dòng.
  - Job tree; Copy dump; Deep scan làm `raw-suspend` có frame.
  - Step Over → tab tự làm mới.
  - Chạy với `-Dunanchored=1` (VM options) → đủ 6 coroutine.

  Chụp ảnh sáng/tối và zh, chụp trước và sau.

- [ ] **Step 4: Trước PR** chạy theo `CLAUDE.md`:
  - `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace`.
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm knip`, `pnpm test`, `pnpm build`.
  - Không chạy các lệnh dài chung một shell.
- [ ] **Step 5: Commit**

```bash
git add smoke/debug.test.ts
git commit -m "feat(debugger): smoke-test the coroutine view on the Kotlin fixture"
```

---

## Sửa spec đề xuất

Coordinator áp dụng; plan này không sửa spec.

1. **§6.1 bất biến 4 và 5.**
   - 4 thành: "Kiểm `SuspendCount` một lần mỗi lượt chèn, và kiểm lại sau mỗi invoke của adapter. Trước mỗi lần ghi kiểm không có invoke đang chờ; có thì chờ nó xong, không bỏ lượt."
   - 5 thành: "Lệnh dài (`InstanceCounts`, `Instances`, `ReferringObjects`) một lệnh một lúc. Lệnh ngắn (GetValues, ReferenceType, Frames, ThisObject, Name, LineTable…) được pipeline tối đa 8 lệnh trong một lượt."
   - Số đo: `link.command` tuần tự 77,8 µs/lệnh, pipeline W=8 10,8 µs (W=32 11,8, W=512 16,2), JVM sống sau dispose (M3 G2). Với kotlin-lsp, 5 lần dừng có 0 lần phải chờ invoke (M3 G3).
2. **§9 nguồn B.** Thay "Quét `Instances` theo class chỉ khi người dùng bấm 'Deep scan'" bằng: "Snapshot gồm đi đồ thị + kiểm khoảng hở: `InstanceCounts` trên các class con của `AbstractCoroutine`, và `Instances` cho class đếm được nhiều hơn số đã thấy. Deep scan chỉ còn để tìm frame cho coroutine treo ở `suspendCoroutine` thô."
   - Số đo: anchored 22/23 bằng đi đồ thị, sót duy nhất `global-raw`. Scope riêng không có `delay` thì 0/8 (M3 G6). Kiểm khoảng hở trên heap nhỏ 37–45 ms. Heap 10M: `InstanceCounts` 488 ms (JDK 21) / 513 ms (JDK 25), `Instances` ~170 ms mỗi class (M3 G2).
   - Thay con số "~450 ms mỗi class ở 30M object" bằng "~170 ms mỗi class ở 10M object; quét đủ 42 class 7,1 s (JDK 21) / 6,8 s (JDK 25)".
3. **§9 frame.** Thêm "frame đi tiếp qua `ScopeCoroutine.uCont` (cả `DispatchedCoroutine`, `UndispatchedCoroutine`); qua `DebugProbesImpl$CoroutineOwner.delegate` khi có agent". Số đo: 4 trong 7 leaf mà probe không theo `uCont` bị sót (M3 G1).
4. **§9 bảng phạm vi.** Dòng "Run/Debug do app khởi động" thêm "kotlin-lsp attach kiểu K1: không có `DebugProbesImpl` (null ở 5/5 lần dừng), chỉ nguồn Graph" (M3 G3). Đoạn "Agent là tuỳ chọn" thêm "bật kèm `-Dkotlinx.coroutines.debug.enable.creation.stack.trace=true`; resume chuỗi suspend 20 tầng ×20 trên 1.9.0 (17 → 346 ms), con số `launch` 200k không tái hiện được" (M3 G5).
5. **§9 `@DebugMetadata`.** "Bytes `.class` trên classpath" thành "Thư mục và jar lấy từ `VirtualMachine.ClassPaths` (1/13) của debuggee; Gradle `run`/`test --debug-jvm` trả 6/14 mục và có đủ class của app và của kotlinx (M3 G4); jar lồng (Spring Boot) chưa hỗ trợ [SL]".
6. **§13.** `debug_jvm_coroutines(session)` thành `debug_jvm_coroutines(session, refresh: auto|full|deepFrames)`, trả `ready|notUsed|unavailable`. Thêm action `debug.coroutines.refresh`, `debug.coroutines.deepScan`. Ánh xạ thread kotlin-lsp: tên DAP `"name"@<id JDWP, có dấu phẩy nhóm số>` (M3 G3).
7. **§2 bảng bằng chứng.** Thêm hàng: "M3 G1–G6 | Coroutine không agent qua link thật: độ phủ, chi phí, kotlin-lsp, classpath | đi đồ thị 21/22–22/23 job trên 1.5.2–1.11.0, 0/8 khi không neo → kiểm khoảng hở; 10,8 µs/lệnh pipeline; kotlin-lsp không có registry, 0 lần chờ invoke; ClassPaths đủ cho Gradle run/test". **§4 hàng Coroutine:** "Đo được" thành "registry agent 15–22 ms; đi đồ thị 32–39 ms (~520 lệnh, fixture 23 coroutine); 10k coroutine ~2,6 s qua batch (ước lượng từ 10,8 µs × ~24 lệnh); kiểm khoảng hở 37–45 ms heap nhỏ, ~0,5 s + 0,17 s/class ở 10M".
8. **§17 ghi chú cuối** ("Kotlin chạy qua java-debug (dự án trộn) được xét ở M3"): ghi kết quả xét. Module có mã Kotlin luôn debug bằng adapter Kotlin, cả launch (`java.ts:132`) và attach Gradle/Maven (`javaAttachConfig`). java-debug chỉ gặp coroutine khi một module Java dùng thư viện Kotlin. Để sau, xem quyết định 4.

## Cần chủ repo quyết định

1. **Tự làm mới khi dừng.** Mặc định khuyến nghị: tab mở thì mỗi lần dừng làm mới đầy đủ, gồm kiểm khoảng hở. Nếu lần kiểm trước mất > 300 ms thì chỉ đi đồ thị, hiện "may be incomplete" kèm Refresh. Lý do: `InstanceCounts` là một lệnh dài chặn lệnh của adapter khoảng 0,5 s ở heap 10M, mỗi lần step.
2. **Giới hạn số coroutine.** Mặc định `MAX_COROUTINES = 20_000` (~5 s qua batch), kèm `truncated` và banner. Không phân trang.
3. **Deep scan.** Mặc định chỉ khi bấm, và nút chỉ hiện khi có coroutine thiếu frame. Không tự chạy, vì cần ~6 s ở heap 10M.
4. **Phiên java-debug** (module Java dùng thư viện Kotlin có coroutine). Mặc định để sau, plan riêng "M3j": lệnh bundle `openidea.jvm.read` cài `JvmInspector::read` qua JDI. Latency mỗi lệnh JDI chưa đo [SL].
5. **Agent trong Gradle/Maven debug.** Mặc định không làm trong M3: Task 10 chỉ cho Kotlin app do IDE chạy. Gradle cần thêm `-javaagent` vào `jvmArgs` của task (init script trong `javaDebug.ts`) với jar đúng bản, chưa đo.
6. **`-Dkotlinx.coroutines.debug`.** Mặc định không tự thêm. Không có nó thì `debugId` gần như luôn trống; tên `CoroutineName` vẫn hiện.
7. **Fat jar / jar lồng Spring Boot.** Mặc định không đọc jar lồng trong M3: frame hiện `Class.method`, không có dòng, `missing: metadata`. `bootRun` dùng classpath mở rộng nên không bị ảnh hưởng.

## M3b

M3b (async stack trong panel Frames và smart step-over qua điểm treo, chỉ cho fwcd theo spec §9) **có plan riêng**, viết sau khi M3 và K1 merge. M3b dùng lại `JvmInspector::read`, `debug_metadata` và quy tắc chuỗi `completion`/`uCont` của plan này. Phần step cần spike riêng (`nl` của DebugMetadata v2, `InstanceOnly`) trên fwcd thật.

## Ngoài phạm vi M3

Biến spill của frame async (`s`/`n` đã được parse, chưa hiển thị). Gộp stack giống nhau trong dump. Phiên java-debug (quyết định 4). Windows chưa kiểm [SL].
