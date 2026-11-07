# K0: kotlin-lsp DAP làm debugger Kotlin chính? (kết quả spike)

Ngày: 2026-11-07 · Bản thử: kotlin-lsp **263.7084.0** (`263.7084.0-EAP`, macOS aarch64) · JDK debuggee 21.0.4-tem (launch dùng JBR 25 kèm theo kotlin-lsp) · Spec gốc: `2026-11-07-jvm-debug-link-design.md` §6, §9, §12, §15.1, §16 R2, §17.3

Mã thử nghiệm và log nằm ngoài repo, trong `scratchpad/k0-spike/` (đường dẫn đầy đủ ở cuối). Tất cả đo bằng chạy thật trừ chỗ ghi **[SL]**.

## Tóm tắt

| #   | Câu hỏi                                                       | Kết quả                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `launch` Kotlin main (Gradle) và trúng 4 loại breakpoint?     | **Có.** `intellij_jvm` launch, `intellij_gradle` launch và `attach` vào JVM do app chạy đều trúng `main`, class ở file khác, thân hàm `inline`, `suspend fun` sau `delay`. Launch **bắt buộc** gọi `intellij.java.resolveLaunch` trước; launch chỉ có `mainClass` treo (180 s không trả lời)                                   |
| 2   | Qua relay có chèn gói JDWP: kotlin-lsp vẫn khoẻ ≥ 3 lần dừng? | **Có.** 22 phiên có chèn, 161 lần chèn thành công (8–42 ms, trung vị 13), tới 40 lần dừng/phiên; stackTrace/variables/evaluate/step/continue đúng. `hold_resumes` **không cần**. Id gói của adapter tối đa 4896, **0** gói trong dải `0x7000_0000+`. **0** `DisposeObjects`; Disable/EnableCollection luôn đi cặp quanh invoke |
| 3   | Async stack / coroutine / step qua điểm treo                  | **Có async frame** trong `stackTrace` thường (cả attach lẫn launch), không có đánh dấu riêng. **Không có** request/event DAP riêng cho coroutine. Step-over từ dòng `delay` tới đúng dòng kế, cùng coroutine                                                                                                                   |
| 4   | Giấy phép                                                     | **Chưa rõ, cần `needs-decision`.** Bản VSIX ghi JetBrains Free Plugin License (cấm cung cấp Plugin cho bên thứ ba); bản standalone không kèm giấy phép của chính server; repo GitHub và formula Homebrew ghi Apache-2.0; README nói "partially closed-source"                                                                  |
| 5   | Phiên bản app cài, khác 263.7084?                             | App cài **bản mới nhất** của `Kotlin/kotlin-lsp` (không ghim). Hôm nay đó là **263.7084.0**, cùng bản với spec; capabilities và hành vi khớp research F                                                                                                                                                                        |

**Khuyến nghị (§12 "Hướng"):** về kỹ thuật kotlin-lsp đạt K0 và tốt hơn fwcd ở mọi điểm đã đo. Nhưng giấy phép không cho phép rõ ràng việc một IDE mã nguồn mở bên thứ ba tự tải về hay đóng gói server, nên **gắn `needs-decision` cho giấy phép và dừng ở đó**. Trong lúc chờ: `JdwpLink` giữ trung lập adapter (`hold_resumes` theo adapter: fwcd `true`, kotlin-lsp `false`), fwcd vẫn là đường mặc định. Nếu chủ repo/pháp lý chấp nhận: kotlin-lsp DAP làm debugger chính khi kotlin-lsp là LSP đang chạy, fwcd làm dự phòng. Nếu không: chỉ fwcd.

## Cách chạy

Một script Python (`scripts/k0.py`, chạy bằng `python3 -I`) đóng vai client: khởi động `bin/intellij-server --stdio --system-path=<scratch> --data-sharing=none` trong thư mục dự án, `initialize`, `didOpen` file main, chờ `$/progress` "Importing" kết thúc, gọi `start_debug_server`, nối DAP qua TCP, đặt breakpoint, ở mỗi lần dừng gọi `threads`, `stackTrace(levels=40)`, `scopes`, `variables`, `evaluate`, rồi `next` (nếu đặt `STEP`) hoặc `continue`.

Chế độ:

- `launch`: DAP `launch` loại `intellij_jvm`, `console: internalConsole` (kotlin-lsp tự chạy JVM).
- `gradle`: DAP `launch` loại `intellij_gradle`.
- `attach`: script tự chạy JVM (`java -XX:+StartAttachListener -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:<p> -cp … <Main>`, như `start_kotlin_debuggee`), đặt relay giữa, rồi DAP `attach` tới cổng relay.
- `terminal`: DAP `launch` với `console: integratedTerminal`; kotlin-lsp gửi `runInTerminal`, script đổi `address=` của agent JDWP sang cổng riêng, đặt relay nghe trên cổng mà adapter định nối, rồi chạy lệnh.

Relay (cùng thiết kế với `dap_spike2.py`): chuyển nguyên byte, ghi lại mọi lệnh của adapter (id, command set/command, thời điểm), chặn reply của id `≥ 0x7000_0000`. Khi `INJECT=1`, ở mỗi lần dừng nó gửi: `IDSizes`, `ThreadReference.SuspendCount` (thread lấy từ event Breakpoint/Step, bỏ qua nếu ≤ 0), `ClassesBySignature` ×4, `VirtualMachine.InstanceCounts`, `ReferenceType.Instances(max 10)`, `ReferenceType.Fields`, `ObjectReference.GetValues` cho từng instance, `StringReference.Value`, rồi `VirtualMachine.DisposeObjects` **đúng số lần** mỗi ObjectID đã nhận (spec §6.2).

Fixture (bản sao trong scratchpad, repo không đổi):

- `kotlin-gradle`: bản sao `fixtures/kotlin-gradle`.
- `coro`: viết mới, kotlinx-coroutines-core 1.9.0, Kotlin 2.0.21, `jvmToolchain(21)`.

```kotlin
// Main.kt
suspend fun outer(w: Worker, i: Int): Int {
    val r = w.work(i, 50L * i)                 // 6
    return r + 1
}
fun main() = runBlocking {
    val w = Worker("w")                        // 11  breakpoint trong main
    val total = twice { x -> x + w.tag.length }
    val jobs = (1..2).map { i -> launch(CoroutineName("job-$i")) { println("job $i -> " + outer(w, i)) } }
    jobs.forEach { it.join() }
    println("total=$total done")
}
// Worker.kt
class Worker(val tag: String) {
    suspend fun work(i: Int, ms: Long): Int {
        val before = i * 10
        delay(ms)                              // 8   điểm treo (thử step)
        val after = before + compute(i)        // 9   sau delay
        return after
    }
    fun compute(n: Int): Int {
        val r = n * 3                          // 14  class khác file
        return r
    }
}
inline fun twice(block: (Int) -> Int): Int {
    val a = block(1)                           // 20  thân hàm inline
    return a + block(2)
}
// Loop.kt: main gọi w.compute(k) 40 lần (soak 40 lần dừng)
```

## Câu 1: Launch

**Lệnh khởi động server debug (cả 4 chế độ):**

```json
→ {"method":"workspace/executeCommand","params":{"command":"start_debug_server","arguments":["file:///…/coro"]}}
← {"result":54370}            // cổng TCP trên 127.0.0.1, 8–24 ms; DAP đi qua TCP, không phải stdio
→ DAP initialize {"adapterID":"intellij_jvm","pathFormat":"path","linesStartAt1":true,"columnsStartAt1":true,
                  "supportsRunInTerminalRequest":true,"supportsInvalidatedEvent":true}
```

Capabilities (giống hệt research F): `supportTerminateDebuggee, supportsBreakpointLocationsRequest, supportsConditionalBreakpoints, supportsConfigurationDoneRequest, supportsEvaluateForHovers, supportsFunctionBreakpoints, supportsHitConditionalBreakpoints, supportsLogPoints, supportsRestartFrame, supportsSetVariable, supportsStepInTargetsRequest, supportsTerminateRequest, supportsThreadDumpRequest`; `exceptionBreakpointFilters`: `caught`, `uncaught`.

**Tham số chạy được:**

| Chế độ          | Bước trước                                                                                                                                                       | Request DAP                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JVM launch      | `executeCommand intellij.java.resolveLaunch [{uri:"file://…/Main.kt", cwd, overrides:{}}]` → `{javaExec, classpath[], modulePath[], vmArgs[], workingDirectory}` | `launch {type:"intellij_jvm", mainClass:"k0.MainKt", file, classPaths, modulePaths, javaExec, vmArgs, cwd, console:"internalConsole"}`                                                             |
| Gradle launch   | `executeCommand intellij.java.resolveBuildToolLaunch [{uri, mainClass}]` → `{tool:"gradle", projectPath:":", sourceSet:"main", scopeClassPaths[]}`               | `launch {type:"intellij_gradle", mainClass, file, buildToolTarget:{uri, moduleName}, classPaths, console}`                                                                                         |
| Terminal launch | như JVM launch                                                                                                                                                   | như JVM launch nhưng `console:"integratedTerminal"`; adapter gửi reverse request `runInTerminal {kind:"integrated", cwd, args:[java, -agentlib:jdwp=…,address=<p>,suspend=y,server=y, …], env:{}}` |
| Attach          | app tự chạy JVM `suspend=y`                                                                                                                                      | `attach {hostName:"127.0.0.1", port, timeout:30000}`                                                                                                                                               |

Thứ tự trong mọi chế độ: request `launch`/`attach` → event `initialized` (ngay, trước khi nối JVM) → `setBreakpoints` (mọi breakpoint báo `verified: true`) → `configurationDone` → response của `launch`/`attach`.

`launch` chỉ có `mainClass` (không `classPaths`, như mô tả "If empty, the LSP server resolves it" trong `package.json` của VSIX): **không bao giờ trả lời** (đợi 180 s, `launch-bare.log`). Client phải tự gọi `resolveLaunch` như extension VS Code.

**Lệnh JVM mà launch tạo ra** (`ps`, launch-coro-step.log; đường dẫn rút gọn):

```
…/kotlin-server-263.7084.0/jbr/Contents/Home/bin/java
  -agentlib:jdwp=transport=dt_socket,address=54601,suspend=y,server=y
  -javaagent:…/plugins/dap-jvm/lib/rt/debugger-agent.jar=file:///…/capture….props
  -Dkotlinx.coroutines.debug.enable.creation.stack.trace=false -Ddebugger.agent.enable.coroutines=true
  -Dkotlinx.coroutines.debug.enable.flows.stack.trace=true -Dkotlinx.coroutines.debug.enable.mutable.state.flows.stack.trace=true
  -Ddebugger.async.stack.trace.for.all.threads=true
  -javaagent:~/.gradle/caches/…/kotlinx-coroutines-core-jvm-1.9.0.jar        ← đúng jar trên classpath của dự án
  -Dfile.encoding=UTF-8 … @/var/folders/…/idea_arg_file… k0.MainKt         ← argfile: -classpath build/classes/kotlin/main:…:intellij.java.rt.jar
```

`javaExec` mà `resolveLaunch` trả về là JBR 25 của kotlin-lsp (dự án chỉ khai `jvmToolchain(21)`). Launch Gradle chạy `gradle :ideRun --init-script <system>/tmp/lsp-dap-launch-….init.gradle -DideRunDebugAgent.0=-agentlib:jdwp=…server=y,suspend=y,address=127.0.0.1:<p> …`, compile rồi fork JVM của toolchain 21 với cùng các agent.

**Breakpoint (mọi chế độ, trích log):**

```
launch-coro.log  (BPS Main.kt:11, Worker.kt:14, Worker.kt:20, Worker.kt:9)
STOP#1 at Main.kt:11       vars [this, result]
STOP#2 at Worker.kt:20     frame "k0.MainKt$main$1.invokeSuspend(Worker.kt:20)"     ← thân hàm inline
STOP#3 at Worker.kt:9      vars [before=10, i=1, 'ms' was optimised out]  eval 'before + compute(5)' -> 25   ← sau delay
STOP#4 at Worker.kt:14     vars [n=1]  eval 'n * 2' -> 2                                                     ← class khác file
STOP#5 at Worker.kt:9      before=20, i=2  eval -> 35
STOP#6 at Worker.kt:14     n=2
event exited {"exitCode": 0}

launch-kg.log  (kotlin-gradle: App.kt:6, Library.kt:27, Library.kt:24)
STOP#1 at App.kt:6 · STOP#2 at Library.kt:27  eval 'isbn.uppercase()' -> "978-1617293290", 'books.size' -> 3 · STOP#3 at Library.kt:24
gradle-coro.log: Main.kt:11, Worker.kt:9 (i=1), Worker.kt:9 (i=2), evaluate đúng
```

`Library.kt:24` là hàm một dòng `books.values.filter { … }`: breakpoint dòng dừng 1 lần ở hàm ngoài, không dừng trong lambda (3 phần tử). Đây là ngữ nghĩa "line breakpoint" kiểu IntelliJ, không phải lỗi.

**Kết luận:** launch chạy được; app **không bắt buộc** tự chạy JVM. Nhưng để có `JdwpLink`, adapter phải nối qua relay, nên chỉ hai đường dùng được: attach (app chạy JVM như hiện nay) hoặc terminal launch (app chạy lệnh của `runInTerminal`, đổi cổng). Launch `internalConsole` và launch Gradle để adapter tự nối thẳng vào cổng nó chọn, relay không chen được nếu không sửa dòng lệnh **[SL cho Gradle: chưa thử chen]**.

## Câu 2: Qua relay có chèn gói

**Sức khoẻ adapter.** Mọi lần dừng: `threads`, `stackTrace`, `scopes`, `variables` thành công, `evaluate` trả đúng giá trị, `next` và `continue` chạy đúng. Trích:

```
trials/t6-inj1.log (attach, coro, chèn ở mọi lần dừng, step ở Worker.kt:8)
INJECT#2 ok in 13 ms: suspendCount=1 counts=String;=2814, Worker;=1 | Instances(Lk0/Worker;)=1 -> ["tag='w'"] | ids held=2 disposed=2
STOP#3 at Worker.kt:8   eval 'i' -> 1   -> next from Worker.kt:8
INJECT#4 ok in 14 ms … ids held=2 disposed=2
STOP#4 at Worker.kt:9   eval 'i' -> 1
STOP#5 at Worker.kt:14  eval 'n * 2' -> 2
STOP#6 at Worker.kt:14  eval 'n * 2' -> 4
[jvm] job 2 -> 27 / total=5 done / event terminated

soak-loop.log (attach, Loop.kt, 40 lần dừng ở Worker.kt:14, chèn mỗi lần)
stops: 40 injects ok: 40 inject fail: 0
eval 'n * 2'       -> 2 4 6 … 80   (40/40 đúng)
eval 'tag.length + n' -> 5 6 … 44 (40/40 đúng)

attach-kg-inject.log (kotlin-gradle, 6 lần dừng, step Library.kt:27 → 28)
INJECT#3 … Instances(Lcom/example/library/Book;)=3 -> ["isbn='978-1617293290', title='Kotlin in Action', …"] | ids held=12 disposed=12
```

Tổng: 37 phiên qua relay (attach và terminal), 22 phiên có chèn, 161 lần chèn thành công (thời gian một đợt chèn 8–42 ms, trung vị 13 ms, n = 142), 1 lần lỗi do chính probe (`IndexError` khi class chưa nạp, đã sửa). JVM không abort lần nào.

**Một bất thường đã tìm ra nguyên nhân (không do relay).** Hai phiên (một attach, một terminal, đều có chèn) mất 2 lần dừng cuối ở `Worker.kt:14`. Lặp lại 11 + 4 phiên có chèn: không tái hiện. Điểm chung của hai phiên đó là biểu thức `before + compute(5)` được evaluate ngay sau khi step-over qua `delay`, và `compute` có breakpoint. Thử lại **không qua relay, không chèn**:

```
evalbp-attach1/2, evalbp-launch1/2 (INJECT=0, STEP Worker.kt:8, EVALS 'before + compute(5)'):
  breakpoint@Main.kt:11 breakpoint@Worker.kt:20 breakpoint@Worker.kt:8 breakpoint@Worker.kt:9      ← mất cả hai lần dừng ở :14, 4/4
evalbp-nostep (không step, cùng evaluate): đủ 6 lần dừng
trials/t*-inj1 (step, evaluate không gọi hàm): đủ 6 lần dừng, 11/11
```

Đây là lỗi của kotlin-lsp 263.7084: **sau một step qua điểm treo, evaluate gọi hàm có breakpoint làm mọi lần dừng sau đó ở breakpoint đó biến mất**, chương trình chạy tới hết. Giả thuyết "do gói chèn" bị bác bỏ.

**`hold_resumes`: không cần.** Timeline của relay (t6-inj1, giây kể từ lúc bắt đầu):

```
4.77 DAP configurationDone sent
4.86 handshake                         ← adapter chỉ nối JDWP sau configurationDone
4.86 JVM event VMStart policy=2
4.87–5.03 EventRequest.Set ClassPrepare ×15 (policy=1, class filter), ClassUnload, ThreadStart, ThreadDeath
5.04 VM.Resume                         ← Resume đầu tiên, sau khi ClassPrepare đã đặt
5.09 EventRequest.Set Breakpoint ×2    ← đặt khi class được nạp
5.12 JVM event Breakpoint policy=1 → 5.13 VM.Suspend → Thread.Resume
```

Breakpoint của class chưa nạp được đặt qua `ClassPrepare`, nên không có cửa sổ "Resume quá sớm" như fwcd. Mọi phiên dùng `HOLD=0` và mọi breakpoint đều trúng.

**Thống kê lệnh adapter qua 37 phiên:**

- Id gói: bắt đầu từ 1, tối đa **4896**; **0** gói có id trong `[0x7000_0000, 0x8000_0000)`.
- `VirtualMachine.DisposeObjects`: **0** lần, kể cả phiên 40 lần dừng.
- `ObjectReference.DisableCollection` / `EnableCollection`: luôn bằng nhau (12/12 … 80/80 mỗi phiên), đi cặp quanh `InvokeMethod`.
- Breakpoint đặt với `suspendPolicy = EVENT_THREAD (1)`, sau đó adapter tự `VM.Suspend` rồi `ThreadReference.Resume`. Tức là "dừng toàn bộ" được làm bằng hai lệnh, không đọc được từ policy của event.
- **Adapter tự invoke trong VM của người dùng ở mỗi lần dừng**, kể cả khi không có `evaluate` (t6-inj1):

```
static Class.forName(String,boolean,ClassLoader) ×9 · obj ClassLoaders$AppClassLoader.? ×2 · obj ClassLoaders$PlatformClassLoader.? ×3
static com/intellij/rt/debugger/coroutines/CoroutinesDebugHelper.getCoroutineStackTraceDump(Object) ×6
static CoroutinesDebugHelper.tryGetContinuationId(Object) ×4 · getRootContinuation(Object) ×4
static com/intellij/rt/debugger/BatchEvaluatorServer.evaluate2(Object,Object) ×2      ← hiển thị giá trị ("Collecting data…")
obj k0/Worker.? ×3 · obj MainKt$main$1.? ×2 · obj CombinedContext.? ×2                ← toString / get trên object người dùng
terminal (có agent): static com/intellij/rt/debugger/agent/CaptureStorage.getCapturedStackForThread(int,Thread) ×4
```

Nghĩa là kotlin-lsp nạp class trợ giúp `com.intellij.rt.debugger.*` vào classloader của chương trình và gọi chúng khi dừng.

Log `intellij-server.log` của kotlin-lsp không có ERROR nào liên quan JDWP hay gói lạ; chỉ có `WARN CoroutineBreakpointFacility - No clear stepping breakpoint installed …` mỗi lần step (có cả khi không chèn).

## Câu 3: Async stack, coroutine, step

**Async frame có trong `stackTrace` thường.** Không có frame `presentationHint: "label"` hay dấu ngăn cách; frame thư viện mang `presentationHint: "subtle"`; tên frame có tiền tố `at `.

```
attach (không agent), dừng ở Worker.kt:9 sau delay — trials/t6-inj1.log STOP#4 (26 frame)
at k0.Worker.work(Worker.kt:9)
at k0.MainKt.outer(Main.kt:6)                              ← async: người gọi đang treo, lấy từ chuỗi continuation
at k0.MainKt$main$1$jobs$1$1.invokeSuspend(Main.kt:13)     ← async: lambda launch
at kotlin.coroutines.jvm.internal.BaseContinuationImpl.resumeWith(ContinuationImpl.kt:33)   subtle   ← từ đây là stack thật
at kotlinx.coroutines.DispatchedTaskKt.resume(…) … EventLoopImplBase.processNextEvent … runBlocking … MainKt.main(Main.kt:10)

launch (có agent), cùng điểm — launch-coro.log STOP#3 (35 frame)
at k0.Worker.work(Worker.kt:9) · at k0.MainKt.outer(Main.kt:6) · at k0.MainKt$main$1$jobs$1$1.invokeSuspend(Main.kt:13)
at …BaseContinuationImpl.resumeWith$$$capture(…:33) · …DebugProbesImpl$CoroutineOwner.<init>(…:531) · …createCoroutineUnintercepted
at …CoroutineStart.invoke · AbstractCoroutine.start · BuildersKt.launch · k0.MainKt$main$1.invokeSuspend(Main.kt:13)   ← stack lúc tạo coroutine
at …runBlocking … k0.MainKt.main(Main.kt:10)
```

Phần "người gọi đang treo" có trong cả hai chế độ (attach có được nhờ invoke `CoroutinesDebugHelper`). Stack lúc tạo coroutine chỉ có khi JVM chạy với `debugger-agent.jar` (launch, terminal, Gradle).

**Không có phần mở rộng DAP cho coroutine.** 0 event lạ trong mọi phiên (chỉ `initialized, output, stopped, continued, invalidated, thread, exited, terminated`). Không có capability riêng ngoài `supportsThreadDumpRequest`. Thử request `threadDump`, `coroutines`, `coroutineDump`, `dumpCoroutines` (có và không có `threadId`): đều trả `success=false`, `"no handler for request: <tên>"`, phiên vẫn chạy tiếp. Mã client VS Code (`vscode-extension-core/src/dap.ts` trên GitHub, `extension.js` trong VSIX) không dùng `customRequest` hay custom event nào. Tên request đi với `supportsThreadDumpRequest` chưa tìm ra.

**Step-over qua điểm treo:** từ `Worker.kt:8` (`delay(ms)`), `next` dừng ở `Worker.kt:9` với `i = 1` (cùng coroutine), `reason: "breakpoint"`. Kết quả này lặp lại ở launch, attach, attach + chèn (11/11) và terminal + chèn (4/4). Hai điều cần biết:

- Trong lúc step, breakpoint mà **coroutine khác** chạm phải bị bỏ qua và không báo. Breakpoint `Worker.kt:8` dừng 2 lần (i = 1, i = 2) khi không step, nhưng chỉ 1 lần khi step từ lần đầu (launch-coro-step.log và mọi trial có step).
- Lỗi evaluate sau step đã nêu ở câu 2.

Các điểm đã biết từ research F được xác nhận lại trên 263.7084: id thread thay đổi mỗi lần dừng (thread `main` lần lượt là 9, 34, 57, 88, 128, 166 trong một phiên), `source.path` là URI `file:///…`, event `invalidated {"areas":["variables"]}` kèm giá trị tạm `Collecting data…`.

## Câu 4: Giấy phép (trích nguyên văn, không diễn giải)

**a) VSIX `kotlin-server-0.0.27-mac-aarch64.vsix` (release 263.7084.0), `extension/LICENSE.txt`**, được trỏ tới bởi `extension.vsixmanifest` (`<License>extension/LICENSE.txt`) và `package.json` (`"license": "SEE LICENSE IN LICENSE.txt"`):

> JETBRAINS FREE PLUGIN LICENSE AGREEMENT
> Version 1.0, effective as of September 15, 2025
>
> THIS IS A LEGAL AGREEMENT. BY CLICKING ON THE "I AGREE" (OR SIMILAR) BUTTON THAT IS PRESENTED TO YOU AT THE TIME OF INSTALLATION, OR BY DOWNLOADING, INSTALLING, COPYING, SAVING ON YOUR DEVICE, OR OTHERWISE ACCESSING OR USING THE PLUGIN, YOU ACCEPT THIS AGREEMENT AND BECOME A PARTY TO IT, …

> "Plugin" means any JetBrains plugin, extension, application, widget, or other JetBrains software, including AI models, designed to work with the Product and licensed to You under this Agreement. …
>
> "Product" means any product or service that You access under a separate agreement with JetBrains or a third party.

> 3.1. License. You may install the Plugin on Your Machine free of charge and use it with the relevant Product, as described in this Section 3, depending on where You access the Plugin and provided that You comply with this Agreement, Documentation, and, where applicable, the Acceptable Use Policy. This license is provided as worldwide, non-exclusive, non-transferable, non-sublicensable, and royalty-free for the term of this Agreement.
>
> 3.2. Free Use. Following the installation, You may use the Plugin for free for any commercial or non-commercial purposes always subject to the terms of this Agreement.
>
> For the avoidance of doubt, in cases where the Plugin consists solely of configuration files, connectors, or instructions that enable You to download, install, access, or otherwise obtain JetBrains software as described in Section 2 above, such JetBrains software may be subject to acceptance of a separate agreement, which may include payment clauses. …

> 3.4. Restrictions. Without our express written permission (or unless this right is granted by applicable law), You may not:
> (b) reverse-engineer, disassemble, or decompile the Plugin, or parts thereof, or try to derive the source code of the Plugin in any way;
> (c) modify, alter, adapt, translate, enhance, tamper with, repair, or otherwise create derivative works of the Plugin or any part thereof;
> (d) sell, rent, lease, sublease, license, sublicense, lend, time-share, transfer, assign, provide the use of, or otherwise provide the Plugin or access to the Plugin to any third party, whether in whole or in part;
> (f) access the Plugin in order to build a similar or competitive product or service, as well as copy any ideas, features, functions, or graphics of the Plugin or any part thereof.

> 8.2. Termination. We may terminate this Agreement … if: … (c) We elect to discontinue providing the Plugin, in whole or in part; in this case, We will send the notice at least thirty (30) days before the termination.
>
> 10.1. Reservation of Rights. We reserve the right at any time to cease Our support of the Plugin and to alter the pricing, features, specifications, capabilities, functions, terms of use, release dates, general availability, and other characteristics of the Plugin.

`extension/readme.md` trong VSIX: "See [JetBrains Free Plugin License Agreement](https://www.jetbrains.com/legal/docs/terms/jetbrains-free-plugin-license)." Trang đó hôm nay là **"Version 1.1, effective as of August 13, 2026"**. Các mục 3.1, 3.2 (đoạn đầu) và 3.4(d) có cùng câu chữ như trên (chỉ kiểm ba mục này).

**b) Bản standalone `kotlin-server-263.7084.0-aarch64.sit`** (bản app cài; SHA-256 `b403bf8a…94b8`, khớp file `.sha256`): **không có file giấy phép nào cho chính server**. `license/` chỉ chứa giấy phép bên thứ ba (`javahelp_license.txt`, `javolution_license.txt`, `yourkit-license-redist.txt`, `saxon-conditions.html`, `third-party-libraries.{html,json}`, `launcher-third-party-libraries.html`, `filewatcher_jni-third-party-libraries.json`). `product-info.json`: `"versionSuffix": "EAP"`; `--version` → `263.7084.0-EAP`.

```
$ bin/intellij-server --show-eula
Bundle is malformed: EULA.txt is missing.

$ bin/intellij-server --help   (trích)
  --eula=<text>   Hash of the bundled EULA (`EULA.txt`) that the user has accepted. Required for bundled
                  distributions; the launcher passes the hash from its bundle. An accepted hash is remembered
                  for the user and machine, so only the first launch requires it …
  --license-key / --license-key-file / --license-server …
  --region=<value>  Region for product terms and data processing …
Commands:
  license  Manage the `intellij-server` license without starting the server
           (status | login | activate | trial | reset)

$ IJ_JAVA_OPTIONS=-Dintellij.server.license.dir=<scratch> bin/intellij-server license status
License: licensed
Source: eap (Valid), licensed to kotlin-server EAP user: <tên tài khoản JetBrains đã đăng nhập trên máy>, valid through 2026-11-13 (5 days left)
Account: <đã ẩn>
This build does not require a license.
```

Không có `EULA.txt` trong VSIX lẫn bản standalone, nên **không đọc được văn bản EULA mà cờ `--eula` nhắc tới**. `extension.js` trong VSIX có trình hướng dẫn lần đầu ("select region", "accept EULA", "choose data-sharing preference") và đọc `server/EULA.txt`.

**c) Repo GitHub `Kotlin/kotlin-lsp`:** `LICENSE.txt` là Apache License 2.0 (API GitHub: `apache-2.0`). File nguồn mang header "Use of this source code is governed by the Apache 2.0 license." (ví dụ `vscode-extension-core/src/dap.ts`). `README.md`:

> The language server is based on the most recent IntelliJ IDEA version and proprietary parts of JetBrains Air and Fleet products, making it partially closed-source.
>
> Currently, direct contributions are not supported as this repository is a read-only mirror …

**d) Formula Homebrew `JetBrains/homebrew-utils` `Formula/kotlin-lsp.rb`** (JetBrains duy trì, tải đúng file `.sit` trên): `license "Apache-2.0"`.

**Điểm mơ hồ (để chủ repo/pháp lý quyết, tôi không diễn giải):**

1. Văn bản nào áp cho **binary server bản standalone** mà app tải: bản đó không kèm giấy phép; VSIX chứa cùng server thì ghi Free Plugin License; repo và Homebrew ghi Apache-2.0, nhưng README nói có phần độc quyền.
2. §3.4(d) cấm "provide the Plugin … to any third party" nếu không có văn bản cho phép. Văn bản không nói tới trường hợp một IDE bên thứ ba **tự tải** server từ `download.jetbrains.com` về máy người dùng, hay hiện lời mời cài.
3. §3.1 cho dùng "with the relevant Product", mà "Product" là sản phẩm dùng theo một thoả thuận riêng. Không rõ OpenIDEA có được tính là "Product".
4. §3.4(f) nhắc "a similar or competitive product". OpenIDEA là một IDE.
5. Cờ `--eula` ("Required for bundled distributions") và các lệnh `license login/activate/trial` cho thấy có một EULA và cơ chế cấp phép khác, nhưng văn bản không có trong cả hai bản phát hành. Giấy phép "eap … valid through 2026-11-13" đi cùng "This build does not require a license": không rõ bản sau có đòi giấy phép không.
6. Không điều khoản nào nói riêng về phần debugger (`plugins/dap-jvm`).

Ghi chú: app **đã** tự tải kotlin-lsp cho LSP từ trước (`crates/ide-tools/src/registry.rs`), nên câu hỏi giấy phép đã có sẵn, không phải do K0 sinh ra. K0 chỉ tăng mức phụ thuộc. Spike này dùng kotlin-lsp như hộp đen (DAP và JDWP trên kênh của mình), không giải nén hay dịch ngược jar của nó.

## Câu 5: Phiên bản

`registry.rs` (`kotlin-lsp`): `ReleaseSource::GitHub { repo: "Kotlin/kotlin-lsp" }` với `version: V` (`const V = None`, không ghim). `sources.rs` gọi `https://api.github.com/repos/{repo}/releases/latest`. Release không có asset; app lấy link trong release notes theo mẫu `kotlin-server-*-aarch64.sit` / `.sit` / `.tar.gz` / `.win.zip` và chạy `bin/intellij-server --stdio` (`languages/kotlin.toml`). Hôm nay:

```
$ gh api repos/Kotlin/kotlin-lsp/releases --jq '.[0:3][] | "\(.tag_name) \(.published_at)"'
kotlin-lsp/v263.7084.0 2026-10-17T10:32:52Z      ← latest
kotlin-lsp/v263.6379.0 2026-10-03T14:35:13Z
kotlin-lsp/v263.4702.0 2026-09-13T22:53:03Z
```

Nên app cài **263.7084.0**, đúng bản spec ghi. Capabilities, thứ tự event, `invalidated`, id thread không ổn định và `file://` khớp research F. Changelog 263.7084.0 có: "Step Over and Step Into now work inside Kotlin scope functions …" và "Async stack traces for coroutines are now available when you debug a launch, also for a Gradle launch configuration". Ba bản gần nhất ra cách nhau 2–3 tuần, và app luôn lấy bản mới nhất, nên hành vi DAP có thể đổi ở bất kỳ lần cập nhật nào.

## Đề xuất sửa spec

1. **§0, dòng "Adapter Kotlin":** cột "Bản 2" thành "kotlin-lsp DAP đạt K0 về kỹ thuật (launch, relay + gói chèn, async stack, step qua `delay`); giấy phép: `needs-decision`; fwcd vẫn mặc định cho tới khi chốt".
2. **§2:** thêm dòng `K0 | kotlin-lsp DAP qua relay + gói chèn; launch; giấy phép | Kỹ thuật đạt [XM]: 22 phiên chèn, 161 lần chèn, 0 lỗi do relay; giấy phép mơ hồ (xem K0 §4)`. Xoá "kotlin-lsp DAP qua relay có chịu gói chèn" khỏi danh sách **[SL]**.
3. **§6.1 (1):** "(fwcd cần, adapter khác thì `false`)" → "(fwcd cần; kotlin-lsp 263.7084 **không** cần [XM K0]: nó chỉ nối JDWP sau `configurationDone` và đặt `ClassPrepare` trước `Resume` đầu tiên)".
4. **§6.1 (4):** thêm "kotlin-lsp tự `InvokeMethod` ở mỗi lần dừng (`CoroutinesDebugHelper`, `BatchEvaluatorServer.evaluate2`, `toString`, `Class.forName`) và breakpoint của nó dùng policy `EVENT_THREAD` rồi `VM.Suspend`. Vì vậy trạng thái dừng không suy được từ event, và `SuspendCount` có thể bằng 0 khi adapter đang invoke: bỏ lần chèn đó, thử lại sau".
5. **§6.2:** thêm "[XM K0] kotlin-lsp gọi `DisableCollection`/`EnableCollection` theo cặp quanh invoke (12–80 cặp mỗi phiên) và không gửi `DisposeObjects` (0/37 phiên). Link vẫn đếm và dispose phần của mình; lỗi `INVALID_OBJECT (20)` trên ID của link là 'object đã mất', không chuyển `Degraded`".
6. **§9, "Async stack … và smart step-over (M3b)":** thêm "Với kotlin-lsp, `stackTrace` đã có frame async (người gọi đang treo; stack lúc tạo khi chạy bằng agent của nó) và step qua điểm treo đúng dòng [XM K0], nên M3b chỉ còn cần cho fwcd. Panel Frames không phân biệt được frame async (không có `presentationHint`)".
7. **§9, đoạn "Agent là tuỳ chọn":** thêm "Launch của kotlin-lsp (cả Gradle) **tự thêm** `-javaagent:<kotlinx-coroutines-core trên classpath>` và `debugger-agent.jar` của nó. Nếu app dùng đường đó thì agent luôn bật, trái mặc định 'tắt' ở đây. Phiên attach do app chạy JVM thì không có agent".
8. **§12:** đoạn kotlin-lsp, thay "**Rủi ro:** … chưa thử qua relay, chưa thử launch." bằng kết quả K0: launch cần `resolveLaunch` (launch trần treo); DAP qua TCP từ `start_debug_server`; relay chỉ chen được ở attach hoặc launch `integratedTerminal` (`runInTerminal`); lỗi evaluate sau step; breakpoint của coroutine khác bị bỏ qua khi step; adapter nạp class `com.intellij.rt.debugger.*` vào VM người dùng. Đoạn **Hướng** thay bằng khuyến nghị ở đầu tài liệu này.
9. **§13:** thêm "`ide-dap` cần transport DAP qua TCP (cổng do `workspace/executeCommand start_debug_server` của phiên kotlin-lsp đang chạy trả về, tham số `[workspaceFolderUri]`) và gọi `intellij.java.resolveLaunch` trước `launch`".
10. **§15:** thí nghiệm 1 → "~~kotlin-lsp DAP qua relay + gói chèn; launch; EULA~~ (đã làm, K0; giấy phép chờ quyết định)". Thêm: "chen relay vào launch Gradle của kotlin-lsp".
11. **§16 R2:** mức "Cao" giữ nguyên, nhưng lý do đổi thành "giấy phép mơ hồ; bản không ghim, ra bản mới mỗi 2–3 tuần; lỗi evaluate sau step". Giảm thiểu: "`needs-decision`; fwcd dự phòng; smoke `debug.test.ts` cho kotlin với bản cài thật".
12. **§17.3:** "Kỹ thuật đã đạt (K0). Giấy phép: `needs-decision`, chủ repo xem K0 §4 trước khi bật kotlin-lsp DAP".

## Tệp và cách chạy lại

Tất cả trong `/private/tmp/claude-501/-Users-nguyenbang-code-openidea/7ba2b63d-14ee-47dc-ad14-5817bf32327c/scratchpad/k0-spike/`:

- `scripts/k0.py`: probe. Ví dụ: `PROJ=coro INJECT=1 BPS="Main.kt:11,Worker.kt:14,Worker.kt:20,Worker.kt:8" STEP="Worker.kt:8" EVALS="i|n * 2" python3 -I scripts/k0.py attach`. Chế độ khác: `launch`, `gradle`, `terminal`; biến `PROJ=kg`, `MAIN=k0.LoopKt`, `MAXSTOPS`, `CUSTOM`, `BARE=1`, `TL`.
- `scripts/ctx.py`: trích ngữ cảnh chuỗi trong `extension.js`.
- `dl/`: bản tải về (`.sit`, `.vsix`, bản giải nén `x/`, `vsix-meta/`).
- `work/fixtures/{kotlin-gradle,coro}`, `work/*.log`, `work/trials/*.log`, `work/help.clean.txt`, `work/gh-README.md`.

Đã dừng hai Gradle daemon 9.7.0 mà lần import của kotlin-lsp khởi động (chạy bằng JBR trong `k0-spike/dl`). Một `KotlinCompileDaemon` (pid 4223) do task `:ideRun` khởi động dưới Gradle daemon có sẵn (pid 62821) được để lại; nó tự thoát khi rảnh.
