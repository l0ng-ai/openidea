package ai.openidea.jvminspect;

import com.sun.jdi.VirtualMachine;
import java.lang.reflect.Field;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * java-debug's live VMs, read through its internals. Nothing here is API: every step that no
 * longer resolves is {@link Unsupported}, never a crash.
 */
final class ConnectedVms {
    static final String PROVIDER = "com.microsoft.java.debug.plugin.internal.JdtVirtualMachineManagerProvider";

    static final class Unsupported extends Exception {
        private static final long serialVersionUID = 1L;

        Unsupported(String detail) {
            super(detail);
        }
    }

    private ConnectedVms() {}

    /**
     * @param loader loads a class of the java-debug bundle by name; {@code null} when it is not there
     * @return a copy of {@code AdvancedVirtualMachineManager.connectedVMs}
     */
    static List<VirtualMachine> read(Function<String, Class<?>> loader) throws Unsupported {
        Class<?> provider = loader.apply(PROVIDER);
        if (provider == null) throw new Unsupported(PROVIDER + " not found");
        try {
            // The provider keeps the manager in a static field, so a new provider returns java-debug's one.
            Object manager = provider.getMethod("getVirtualMachineManager").invoke(provider.getDeclaredConstructor().newInstance());
            List<?> vms = (List<?>) field(manager.getClass(), "connectedVMs").get(manager);
            List<VirtualMachine> out = new ArrayList<>();
            // a Collections.synchronizedList that java-debug changes as sessions start and end
            synchronized (vms) {
                for (Object vm : vms) out.add((VirtualMachine) vm);
            }
            return out;
        } catch (ReflectiveOperationException | RuntimeException e) {
            throw new Unsupported(e.toString());
        }
    }

    /** {@code VirtualMachineImpl.packetReceiveManager()} → {@code PacketManager.fConnection} → {@code SocketConnection.fSocket}. */
    static Socket socket(VirtualMachine vm) throws Unsupported {
        try {
            Object receiver = vm.getClass().getMethod("packetReceiveManager").invoke(vm);
            Object connection = field(receiver.getClass(), "fConnection").get(receiver);
            return (Socket) field(connection.getClass(), "fSocket").get(connection);
        } catch (ReflectiveOperationException | RuntimeException e) {
            throw new Unsupported(e.toString());
        }
    }

    private static Field field(Class<?> type, String name) throws NoSuchFieldException {
        for (Class<?> k = type; k != null; k = k.getSuperclass()) {
            try {
                Field f = k.getDeclaredField(name);
                f.setAccessible(true);
                return f;
            } catch (NoSuchFieldException e) {
                // declared further up
            }
        }
        throw new NoSuchFieldException(type.getName() + "." + name);
    }
}
