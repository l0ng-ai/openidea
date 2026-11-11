# JVM inspection inside java-debug

An OSGi bundle loaded into JDT LS next to microsoft java-debug. While a Java debug session is
suspended, it lists the instances of a class, the fields of an object and the objects that refer to
it, and counts the instances of every loaded class. It works on java-debug's own JDI connection to
the debuggee, so no second debugger connects to the JVM.

## Commands

Every command but `openidea.jvm.vms` takes `target` first:
`{"pid": n|null, "host": s|null, "port": n|null, "generation": n}`. A launch session is found by
`pid` (the process java-debug started); an attach session by the remote port of java-debug's socket,
then by `host` when several VMs share that port. Two JVMs running the same program have the same
thread ids and names, so threads are never used to tell sessions apart.

| Command                  | Arguments after `target` | `ok`                                                                               |
| ------------------------ | ------------------------ | ---------------------------------------------------------------------------------- |
| `openidea.jvm.vms`       | none (no `target`)       | `[{pid, remoteHost, remotePort, localPort, version, canGetInstanceInfo, timeout}]` |
| `openidea.jvm.classes`   | none                     | `[{name, instances}]`, classes with no instances left out                          |
| `openidea.jvm.instances` | `className`, `limit`     | `[JvmValue]`, at most 1000                                                         |
| `openidea.jvm.fields`    | `objectId`               | `[{name, value}]`; the first 100 elements, as `"[i]"`, of an array                 |
| `openidea.jvm.referrers` | `objectId`, `limit`      | `[{value, via}]`, at most 200; `via` lists the fields or `"[i]"` slots             |

A reply is `{"ok": payload}` or `{"error": code, "detail": text}`, `code` being one of
`unsupported`, `vmNotFound`, `stale`, `collected`, `classNotLoaded`, `notSuspended`, `timedOut`.
Anything else (a malformed argument, a JDI error the bundle does not expect) is an ordinary
`executeCommand` error. Values have the JSON shape of `ide_jvm_inspect::JvmValue`. JDT LS writes
replies with Gson, which leaves out `null` members: an attached VM has no `pid`, and a long string
no `text`.

- Data is read only while some thread of the VM is suspended (`notSuspended` otherwise), one command
  per VM at a time.
- An `objectId` is valid only in the `generation` (the session's stop) it was returned in; any other
  is `stale`. Each VM keeps a table of the objects the bundle handed out, emptied when the generation
  changes or when it grows past 100 000 entries.
- Previews follow the JDWP link's rules: arrays give only their length, boxed types the primitive in
  their `value` field, a `String` the length of its backing array (by `coder`) and its text only up
  to 1000 characters. Nothing is invoked: no `toString`, no `invokeMethod`.
- A referrer array longer than 10 000 elements is not searched for the slot (`via` is empty).
- An object collected before its preview is left out of `instances` and `referrers`.

`classes` and `referrers` can take seconds on a large heap. Eclipse JDI fails a request after
`getRequestTimeout()` (3000 ms by default), and the timeout is per VM: java-debug's own requests
waiting behind the command time out too. These two commands raise it to at least 60 000 ms and,
when done, put back the old value unless something else changed it meanwhile (java-debug applies its
timeout setting to every VM when it changes).

## Internals it depends on

java-debug is not pinned: the app installs the latest vscode-java-debug. The bundle reaches the VMs
through these non-API members, by reflection:

- `com.microsoft.java.debug.plugin.internal.JdtVirtualMachineManagerProvider#getVirtualMachineManager()`
- `AdvancedVirtualMachineManager.connectedVMs` (a synchronized list)
- `org.eclipse.jdi.internal.VirtualMachineImpl#packetReceiveManager()`
- `org.eclipse.jdi.internal.connect.PacketManager.fConnection`
- `org.eclipse.jdi.internal.connect.SocketConnection.fSocket`

and, as API of `org.eclipse.jdt.debug`, `org.eclipse.jdi.VirtualMachine#getRequestTimeout` /
`#setRequestTimeout` and `org.eclipse.jdi.TimeoutException`. When any of these is missing or
changes shape, every command answers `unsupported`; nothing throws into java-debug.

Checked with JDT LS 1.63.0.202610191322 (`org.eclipse.jdt.debug` 3.27.0) and java-debug plugin
0.53.2 (vscode-java-debug 0.60.0).

## Rebuild

Build dependency: [JDT LS 1.63.0 build 202610191322](https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz),
the same as `java/java-usages`. Check the extracted distribution from its root
(`sha256sum -c /path/to/build-dependencies.sha256`), then with Java 25 on `PATH`:

```sh
python3 build.py /path/to/jdtls          # writes openidea-jvm-inspect.jar
python3 build.py /path/to/jdtls --test   # compiles tests/SelfTest.java with the sources and runs it
```

The build uses the distribution's ECJ and plugin jars plus the `jdimodel.jar` nested in
`plugins/org.eclipse.jdt.debug_*.jar`, sorted inputs and fixed zip timestamps; bytecode targets
Java 21. Build twice and compare: two builds of the checked-in jar gave

```
ab53d0e6b9e492b5c3be1179c793c879db94ba44a421bdbd4f2f33319e03464a  openidea-jvm-inspect.jar
```

Change `Bundle-Version` whenever the jar changes: OSGi caches bundles by version.

## Real JDT LS check

`tests/inspect.py` starts JDT LS with java-debug and this jar, debugs a small `Heap` program (a launch
and two attaches to the same program) and prints `OK`/`FAIL`/`SKIP` per check:

```sh
PATH=/path/to/jdk25/bin:$PATH \
OPENIDEA_TEST_JAVA=/path/to/jdk11/bin/java:/path/to/jdk21/bin/java \
python3 -I tests/inspect.py /path/to/jdtls /path/to/com.microsoft.java.debug.plugin-0.53.2.jar --heap 10000000
```

`OPENIDEA_TEST_JAVA` lists debuggee JDKs (`:`-separated; `;` on Windows). The attaches use the
first; `classes` is checked on the JDK 11 one. With `--heap N`, a JDK 21 JVM holds N objects and a
DAP `evaluate` sent 0.5 s after `classes` starts must succeed, with the timeout back to 3000 after.
It stops every process it started.
