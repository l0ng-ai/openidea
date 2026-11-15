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
    private static final Map<VirtualMachine, ClassType> DEFINED = new IdentityHashMap<>();

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
    static synchronized ClassType classFor(VirtualMachine vm, ThreadReference thread) throws Exception {
        ClassType defined = DEFINED.get(vm);
        if (defined != null) return defined;
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
        DEFINED.put(vm, defined);
        return defined;
    }

    /** Drops the classes of VMs not in {@code live}. */
    static synchronized void retain(Set<VirtualMachine> live) {
        DEFINED.keySet().retainAll(live);
    }

    /**
     * {@code create} with collection disabled at once. JDI hands out a new object unprotected, and the
     * strings it mirrors as arguments too, so either can be collected first; that is retried. JDWP
     * checks the arguments before it invokes, so a retry never runs a call twice.
     */
    static ObjectReference pin(Create create) throws Exception {
        for (int attempt = 1; ; attempt++) {
            try {
                ObjectReference object = create.get();
                object.disableCollection();
                return object;
            } catch (ObjectCollectedException e) {
                if (attempt == PIN_ATTEMPTS) throw e;
            }
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
