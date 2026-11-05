package ai.openidea.implementations;

import java.util.ArrayList;
import java.util.List;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.internal.corext.util.MethodOverrideTester;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.lsp4j.Location;

/**
 * Implementations of the type or method at a position, looked up in the workspace's source
 * folders only. The standard request builds the type hierarchy over every dependency jar too,
 * which takes long in a project with many dependencies; the client falls back to it when the
 * sources have none.
 */
public final class ImplementationsCommand implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        String uri = (String) arguments.get(0);
        int line = ((Number) arguments.get(1)).intValue();
        int column = ((Number) arguments.get(2)).intValue();
        List<Location> result = new ArrayList<>();
        ITypeRoot root = JDTUtils.resolveTypeRoot(uri);
        if (root == null) return result;
        var preferences = JavaLanguageServerPlugin.getPreferencesManager();
        IJavaElement element = JDTUtils.findElementAtSelection(root, line, column, preferences, monitor);
        IMethod method = null;
        IType type;
        if (element instanceof IMethod m) {
            int flags = m.getFlags();
            if (m.isConstructor() || Flags.isStatic(flags) || Flags.isPrivate(flags) || Flags.isFinal(flags)) return result;
            method = m;
            type = m.getDeclaringType();
        } else if (element instanceof IType t) {
            type = t;
        } else {
            return result;
        }
        if (type == null || type.getJavaProject() == null) return result;
        IRegion sources = JavaCore.newRegion();
        for (IJavaProject project : JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects()) {
            for (IPackageFragmentRoot fragmentRoot : project.getPackageFragmentRoots()) {
                if (fragmentRoot.getKind() == IPackageFragmentRoot.K_SOURCE) sources.add(fragmentRoot);
            }
        }
        ITypeHierarchy hierarchy = type.getJavaProject().newTypeHierarchy(type, sources, monitor);
        for (IType subtype : hierarchy.getAllSubtypes(type)) {
            if (monitor.isCanceled()) throw new OperationCanceledException();
            IMember found;
            if (method == null) {
                found = subtype.isInterface() ? null : subtype;
            } else {
                // Seen from the subtype, so its type arguments substitute the method's type variables.
                IMethod overriding = new MethodOverrideTester(subtype, hierarchy).findOverridingMethodInType(subtype, method);
                found = overriding == null || Flags.isAbstract(overriding.getFlags()) ? null : overriding;
            }
            Location location = found == null ? null : JDTUtils.toLocation(found);
            if (location != null) result.add(location);
        }
        return result;
    }
}
