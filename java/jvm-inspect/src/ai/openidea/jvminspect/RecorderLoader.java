package ai.openidea.jvminspect;

import com.sun.jdi.ArrayReference;
import com.sun.jdi.ArrayType;
import com.sun.jdi.ClassObjectReference;
import com.sun.jdi.ClassType;
import com.sun.jdi.Method;
import com.sun.jdi.ObjectCollectedException;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Defines {@code OiRecorder} (see {@code recorder/OiRecorder.java}) in the debuggee, once per VM, in a
 * {@code SecureClassLoader} of its own whose parent is the boot loader, so it sees only the JDK and no
 * class of the program can clash with it.
 */
final class RecorderLoader {
    static final String CLASS_NAME = "OiRecorder";
    private static final String RESOURCE = "OiRecorder.bin";
    private static final int INVOKE = ObjectReference.INVOKE_SINGLE_THREADED;
    private static final int PIN_ATTEMPTS = 3;
    /** Not a WeakHashMap: a ClassType refers to its VM, so the key would never be cleared. */
    private static final Map<VirtualMachine, Slot> DEFINED = new IdentityHashMap<>();

    /** The recorder class of one VM, null until defined; also that VM's lock. */
    private static final class Slot {
        ClassType type;
    }

    interface Create {
        ObjectReference get() throws Exception;
    }

    private RecorderLoader() {}

    /** The recorder's class file, Java 8 bytecode, as {@code build.py} embeds it. */
    static byte[] bytes() throws IOException {
        try (InputStream in = RecorderLoader.class.getResourceAsStream(RESOURCE)) {
            if (in == null) throw new IOException(RESOURCE + " is missing from the bundle");
            return in.readAllBytes();
        }
    }

    /**
     * The recorder class in {@code vm}, defined on first use. {@code thread} must be suspended by an
     * event: defining invokes into it. The loader and the class stay pinned for the VM's life.
     */
    static ClassType classFor(VirtualMachine vm, ThreadReference thread) throws Exception {
        Slot slot;
        synchronized (DEFINED) {
            slot = DEFINED.computeIfAbsent(vm, k -> new Slot());
        }
        // Per VM: defining invokes into the debuggee, which must not hold up the other VMs.
        synchronized (slot) {
            if (slot.type == null) slot.type = define(vm, thread);
            return slot.type;
        }
    }

    /** Drops the classes of VMs not in {@code live}. */
    static void retain(Set<VirtualMachine> live) {
        synchronized (DEFINED) {
            DEFINED.keySet().retainAll(live);
        }
    }

    private static ClassType define(VirtualMachine vm, ThreadReference thread) throws Exception {
        ClassType defined;
        ClassType secureLoader = classType(vm, "java.security.SecureClassLoader");
        ObjectReference loader = pin(() -> secureLoader.newInstance(thread,
                method(secureLoader, "<init>", "(Ljava/lang/ClassLoader;)V"), Collections.singletonList(null), INVOKE));
        ObjectReference type = null;
        ArrayReference array = null;
        try {
            byte[] bytes = bytes();
            ArrayType byteArray = (ArrayType) loaded(vm, "byte[]");
            array = (ArrayReference) pin(() -> byteArray.newInstance(bytes.length));
            List<Value> values = new ArrayList<>(bytes.length);
            for (byte b : bytes) values.add(vm.mirrorOf(b));
            array.setValues(values);
            Method define = method(classType(vm, "java.lang.ClassLoader"), "defineClass", "(Ljava/lang/String;[BII)Ljava/lang/Class;");
            ArrayReference code = array;
            type = pin(() -> (ObjectReference) loader.invokeMethod(thread, define,
                    List.of(vm.mirrorOf(CLASS_NAME), code, vm.mirrorOf(0), vm.mirrorOf(bytes.length)), INVOKE));
            // defineClass only loads; until Class.forName links it, JDI's methodsByName throws ClassNotPreparedException.
            ClassType classClass = classType(vm, "java.lang.Class");
            classClass.invokeMethod(thread, method(classClass, "forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;"),
                    List.of(vm.mirrorOf(CLASS_NAME), vm.mirrorOf(true), loader), INVOKE);
            defined = (ClassType) ((ClassObjectReference) type).reflectedType();
        } catch (Exception | Error e) {
            loader.enableCollection();
            if (type != null) type.enableCollection();
            throw e;
        } finally {
            if (array != null) array.enableCollection();
        }
        return defined;
    }

    /**
     * {@code create} with collection disabled at once. A string JDI mirrors as an argument is
     * unprotected and can be collected before the call; JDWP then refuses the call before it runs, so
     * only that is retried. An object collected after {@code create} returned is not: the call ran, and
     * a second {@code peek} on a linked stream throws in the program.
     *
     * @throws ObjectCollectedException when the object {@code create} returned was collected before it
     *     could be pinned, or every attempt lost an argument
     */
    static ObjectReference pin(Create create) throws Exception {
        for (int attempt = 1; ; attempt++) {
            ObjectReference object;
            try {
                object = create.get();
            } catch (ObjectCollectedException e) {
                if (attempt == PIN_ATTEMPTS) throw e;
                continue;
            }
            object.disableCollection();
            return object;
        }
    }

    static ClassType classType(VirtualMachine vm, String name) throws ConnectedVms.Unsupported {
        return (ClassType) loaded(vm, name);
    }

    static Method method(ClassType type, String name, String signature) throws ConnectedVms.Unsupported {
        List<Method> methods = type.methodsByName(name, signature);
        if (methods.isEmpty()) throw new ConnectedVms.Unsupported(type.name() + "." + name + signature + " not found");
        return methods.get(0);
    }

    private static ReferenceType loaded(VirtualMachine vm, String name) throws ConnectedVms.Unsupported {
        List<ReferenceType> types = vm.classesByName(name);
        if (types.isEmpty()) throw new ConnectedVms.Unsupported(name + " is not loaded in the VM");
        return types.get(0);
    }
}
