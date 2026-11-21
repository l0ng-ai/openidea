package ai.openidea.jvminspect;

import ai.openidea.jvminspect.InspectCommand.Failure;
import ai.openidea.jvminspect.VmSelector.Target;
import ai.openidea.jvminspect.VmSelector.VmInfo;
import com.sun.jdi.VMDisconnectedException;
import com.sun.jdi.VirtualMachine;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;

/**
 * {@code openidea.jvm.exceptions.set [target, {breakpoints}]}: the VM's exception breakpoints on a
 * chosen class (see {@link ExceptionBreakpoints}). Replies have the shape of {@link InspectCommand}'s.
 */
public final class ExceptionCommand implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) {
        try {
            List<VmInfo> vms = InspectCommand.connected();
            Set<VirtualMachine> live = Collections.newSetFromMap(new IdentityHashMap<>());
            for (VmInfo v : vms) live.add(v.vm());
            ExceptionBreakpoints.forgetGone(live);
            VirtualMachine vm = InspectCommand.select(vms, Target.of(arguments.get(0)));
            List<ExceptionBreakpoints.Spec> specs = new ArrayList<>();
            Object list = ((Map<?, ?>) arguments.get(1)).get("breakpoints");
            if (list instanceof List<?> items) {
                for (Object item : items) specs.add(ExceptionBreakpoints.Spec.of(item));
            }
            return InspectCommand.ok(ExceptionBreakpoints.set(vm, specs));
        } catch (Failure e) {
            return InspectCommand.error(e.code, e.getMessage());
        } catch (ConnectedVms.Unsupported e) {
            return InspectCommand.error("unsupported", e.getMessage());
        } catch (org.eclipse.jdi.TimeoutException e) {
            return InspectCommand.error("timedOut", String.valueOf(e.getMessage()));
        } catch (VMDisconnectedException e) {
            return InspectCommand.error("vmNotFound", "the VM disconnected");
        }
    }
}
