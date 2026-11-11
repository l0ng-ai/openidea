package ai.openidea.jvminspect;

import com.sun.jdi.VirtualMachine;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Finds the VM of one debug session. Thread lists cannot tell two attach sessions apart: two JVMs
 * running the same program have the same thread ids and names.
 */
final class VmSelector {
    /** The JSON {@code {"pid", "host", "port", "generation"}} the client sends first; pid for launch, host and port for attach. */
    record Target(Long pid, String host, Integer port, long generation) {
        static Target of(Object json) {
            Map<?, ?> m = (Map<?, ?>) json;
            Number pid = (Number) m.get("pid");
            Number port = (Number) m.get("port");
            return new Target(pid == null ? null : pid.longValue(), (String) m.get("host"),
                    port == null ? null : port.intValue(), ((Number) m.get("generation")).longValue());
        }
    }

    /** {@code vm} is null in tests. */
    record VmInfo(VirtualMachine vm, Long pid, String remoteHost, Integer remotePort, Integer localPort) {}

    private VmSelector() {}

    /** Empty unless exactly one VM matches. */
    static Optional<VmInfo> select(List<VmInfo> vms, Target target) {
        List<VmInfo> found;
        if (target.pid() != null) {
            found = vms.stream().filter(v -> target.pid().equals(v.pid())).toList();
        } else if (target.port() != null) {
            found = vms.stream().filter(v -> target.port().equals(v.remotePort())).toList();
            if (found.size() > 1 && target.host() != null) {
                Set<InetAddress> addresses = resolve(target.host());
                if (addresses != null) found = found.stream().filter(v -> isOneOf(v.remoteHost(), addresses)).toList();
            }
        } else {
            found = List.of();
        }
        return found.size() == 1 ? Optional.of(found.get(0)) : Optional.empty();
    }

    /** {@code null} when the name does not resolve, so the port alone decides. */
    private static Set<InetAddress> resolve(String host) {
        try {
            return Set.of(InetAddress.getAllByName(host));
        } catch (UnknownHostException | SecurityException e) {
            return null;
        }
    }

    /** The socket's remote address is an IP literal, which parses without a lookup. */
    private static boolean isOneOf(String address, Set<InetAddress> addresses) {
        if (address == null) return false;
        try {
            return addresses.contains(InetAddress.getByName(address));
        } catch (UnknownHostException e) {
            return false;
        }
    }
}
