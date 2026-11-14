package ai.openidea.jvminspect;

import ai.openidea.jvminspect.VmSelector.Target;
import ai.openidea.jvminspect.VmSelector.VmInfo;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.ObjectCollectedException;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.VMDisconnectedException;
import com.sun.jdi.VirtualMachine;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.Platform;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.osgi.framework.Bundle;

/**
 * Lists the instances, fields and referrers of objects in a VM java-debug is connected to. Replies
 * are {@code {"ok": payload}} or {@code {"error": code, "detail": text}}; the codes are matched by
 * the Rust client.
 */
public final class InspectCommand implements IDelegateCommandHandler {
    private static final String JAVA_DEBUG = "com.microsoft.java.debug.plugin";
    /** For the commands that can take seconds on a large heap. */
    private static final int SLOW_REQUEST_MS = 60_000;
    private static final int MAX_INSTANCES = 1000;
    private static final int MAX_REFERRERS = 200;
    private static final int ARRAY_PREVIEW = 100;
    private static final int REFERRER_ARRAY_SCAN = 10_000;
    /** One per connected VM; also the lock that runs one command per VM at a time. */
    private static final Map<VirtualMachine, Handles<ObjectReference>> HANDLES = new IdentityHashMap<>();

    private static final class Failure extends Exception {
        private static final long serialVersionUID = 1L;
        final String code;

        Failure(String code, String detail) {
            super(detail);
            this.code = code;
        }
    }

    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) {
        try {
            List<VmInfo> vms = describe(ConnectedVms.read(InspectCommand::loadJavaDebug));
            if (command.equals("openidea.jvm.vms")) return ok(summaries(vms));
            Target target = Target.of(arguments.get(0));
            VirtualMachine vm = VmSelector.select(vms, target)
                    .orElseThrow(() -> new Failure("vmNotFound", "no single VM matches " + target)).vm();
            Handles<ObjectReference> handles = handles(vm);
            synchronized (handles) {
                if (!vm.canGetInstanceInfo()) throw new Failure("unsupported", "the VM cannot list instances");
                if (vm.allThreads().stream().noneMatch(ThreadReference::isSuspended)) {
                    throw new Failure("notSuspended", "no thread is suspended");
                }
                handles.begin(target.generation());
                return ok(switch (command) {
                    case "openidea.jvm.classes" -> classes(vm);
                    case "openidea.jvm.instances" -> instances(vm, handles, (String) arguments.get(1), number(arguments.get(2)).intValue());
                    case "openidea.jvm.fields" -> fields(handles, handles.get(number(arguments.get(1)).longValue()));
                    case "openidea.jvm.referrers" -> referrers(vm, handles, handles.get(number(arguments.get(1)).longValue()),
                            number(arguments.get(2)).intValue());
                    default -> throw new IllegalArgumentException("unknown command " + command);
                });
            }
        } catch (Failure e) {
            return error(e.code, e.getMessage());
        } catch (ConnectedVms.Unsupported e) {
            return error("unsupported", e.getMessage());
        } catch (Handles.Stale e) {
            return error("stale", e.getMessage());
        } catch (ObjectCollectedException e) {
            return error("collected", String.valueOf(e.getMessage()));
        } catch (org.eclipse.jdi.TimeoutException e) {
            return error("timedOut", String.valueOf(e.getMessage()));
        } catch (VMDisconnectedException e) {
            return error("vmNotFound", "the VM disconnected");
        }
    }

    private static Class<?> loadJavaDebug(String name) {
        Bundle bundle = Platform.getBundle(JAVA_DEBUG);
        if (bundle == null) return null;
        try {
            return bundle.loadClass(name);
        } catch (ClassNotFoundException e) {
            return null;
        }
    }

    private static List<VmInfo> describe(List<VirtualMachine> vms) throws ConnectedVms.Unsupported {
        List<VmInfo> out = new ArrayList<>();
        for (VirtualMachine vm : vms) {
            Socket socket = ConnectedVms.socket(vm);
            out.add(new VmInfo(vm, pid(vm), socket.getInetAddress().getHostAddress(), socket.getPort(), socket.getLocalPort()));
        }
        Set<VirtualMachine> live = Collections.newSetFromMap(new IdentityHashMap<>());
        live.addAll(vms);
        synchronized (HANDLES) {
            HANDLES.keySet().retainAll(live);
        }
        return out;
    }

    /** Null for an attached VM, which java-debug did not start. */
    private static Long pid(VirtualMachine vm) {
        try {
            Process process = vm.process();
            return process == null ? null : process.pid();
        } catch (UnsupportedOperationException e) {
            return null;
        }
    }

    private static List<Map<String, Object>> summaries(List<VmInfo> vms) throws ConnectedVms.Unsupported {
        List<Map<String, Object>> out = new ArrayList<>();
        for (VmInfo v : vms) {
            out.add(Values.json("pid", v.pid(), "remoteHost", v.remoteHost(), "remotePort", v.remotePort(), "localPort", v.localPort(),
                    "version", v.vm().version(), "canGetInstanceInfo", v.vm().canGetInstanceInfo(),
                    "timeout", RequestTimeout.Knob.of(v.vm()).get()));
        }
        return out;
    }

    private static Handles<ObjectReference> handles(VirtualMachine vm) {
        synchronized (HANDLES) {
            return HANDLES.computeIfAbsent(vm, k -> new Handles<>());
        }
    }

    /** Every loaded class with at least one instance, from one {@code InstanceCounts} for all of them. */
    private static List<Map<String, Object>> classes(VirtualMachine vm) throws ConnectedVms.Unsupported {
        try (RequestTimeout.Raised raised = RequestTimeout.raise(RequestTimeout.Knob.of(vm), SLOW_REQUEST_MS)) {
            List<ReferenceType> all = vm.allClasses();
            long[] counts = vm.instanceCounts(all);
            List<Map<String, Object>> out = new ArrayList<>();
            for (int i = 0; i < counts.length; i++) {
                if (counts[i] > 0) out.add(Values.json("name", all.get(i).name(), "instances", counts[i]));
            }
            return out;
        }
    }

    /** One that was collected before its preview is left out. */
    private static List<Map<String, Object>> instances(VirtualMachine vm, Handles<ObjectReference> handles, String className, int limit)
            throws Failure {
        List<ReferenceType> types = vm.classesByName(className);
        if (types.isEmpty()) throw new Failure("classNotLoaded", className);
        int wanted = Math.min(limit, MAX_INSTANCES);
        List<ObjectReference> objects = new ArrayList<>();
        for (ReferenceType type : types) {
            int remaining = wanted - objects.size();
            // JDI reads a maximum of 0 as "all of them".
            if (remaining <= 0) break;
            List<ObjectReference> found = type.instances(remaining);
            objects.addAll(found.subList(0, Math.min(remaining, found.size())));
        }
        List<Map<String, Object>> out = new ArrayList<>(objects.size());
        for (ObjectReference object : objects) {
            try {
                out.add(preview(handles, object));
            } catch (ObjectCollectedException e) {
                // gone between the listing and its preview
            }
        }
        return out;
    }

    /** The fields, or {@code "[i]"} for the first {@link #ARRAY_PREVIEW} elements of an array. */
    private static List<Map<String, Object>> fields(Handles<ObjectReference> handles, ObjectReference object) {
        List<Values.Slot> slots = object instanceof ArrayReference array
                ? Values.elements(array, Math.min(array.length(), ARRAY_PREVIEW))
                : Values.instanceFields(object);
        List<Map<String, Object>> out = new ArrayList<>(slots.size());
        for (Values.Slot slot : slots) out.add(Values.json("name", slot.name(), "value", preview(handles, slot.value())));
        return out;
    }

    /** With the field names or array slots that point at {@code target}; a collected referrer is left out. */
    private static List<Map<String, Object>> referrers(VirtualMachine vm, Handles<ObjectReference> handles, ObjectReference target, int limit)
            throws ConnectedVms.Unsupported {
        int wanted = Math.min(limit, MAX_REFERRERS);
        // JDI reads a maximum of 0 as "all of them".
        if (wanted <= 0) return List.of();
        try (RequestTimeout.Raised raised = RequestTimeout.raise(RequestTimeout.Knob.of(vm), SLOW_REQUEST_MS)) {
            List<ObjectReference> found = target.referringObjects(wanted);
            List<Map<String, Object>> out = new ArrayList<>();
            for (ObjectReference referrer : found.subList(0, Math.min(wanted, found.size()))) {
                try {
                    Map<String, Object> value = preview(handles, referrer);
                    List<Values.Slot> slots = referrer instanceof ArrayReference array
                            ? (array.length() <= REFERRER_ARRAY_SCAN ? Values.elements(array, array.length()) : List.of())
                            : Values.instanceFields(referrer);
                    List<String> via = slots.stream().filter(s -> target.equals(s.value())).map(Values.Slot::name).toList();
                    out.add(Values.json("value", value, "via", via));
                } catch (ObjectCollectedException e) {
                    // gone before it could be read
                }
            }
            return out;
        }
    }

    private static Map<String, Object> preview(Handles<ObjectReference> handles, com.sun.jdi.Value value) {
        return Values.preview(value, object -> {
            long id = object.uniqueID();
            handles.put(id, object);
            return id;
        });
    }

    private static Number number(Object argument) {
        return (Number) argument;
    }

    private static Map<String, Object> ok(Object payload) {
        return Values.json("ok", payload);
    }

    private static Map<String, Object> error(String code, String detail) {
        return Values.json("error", code, "detail", detail);
    }
}
