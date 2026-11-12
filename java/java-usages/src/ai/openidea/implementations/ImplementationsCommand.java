package ai.openidea.implementations;

import ai.openidea.Documents;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
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
 * Implementations of the type or method at a position, looked up in the workspace's own code
 * only (source folders and bridged Kotlin classes): {@code {locations, complete}}. The standard
 * request builds the type hierarchy over every dependency jar too, which takes long in a project
 * with many dependencies. {@code complete} when the type is declared in the sources, which no
 * dependency extends; otherwise the client also asks the standard request for the dependencies'
 * implementations.
 */
public final class ImplementationsCommand implements IDelegateCommandHandler {
    /** Classpath attribute of the Kotlin bridge's library entries (`java/kotlin-bridge`). */
    private static final String KOTLIN_OUTPUT = "ai.openidea.kotlin";

    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        Documents.awaitChanges(monitor);
        List<Location> locations = new ArrayList<>();
        boolean complete = find(arguments, locations, monitor);
        return Map.of("locations", locations, "complete", complete);
    }

    /** Adds the implementations to {@code result}; whether they are all there are. */
    private static boolean find(List<Object> arguments, List<Location> result, IProgressMonitor monitor) throws Exception {
        String uri = (String) arguments.get(0);
        int line = ((Number) arguments.get(1)).intValue();
        int column = ((Number) arguments.get(2)).intValue();
        ITypeRoot root = JDTUtils.resolveTypeRoot(uri);
        if (root == null) return false;
        var preferences = JavaLanguageServerPlugin.getPreferencesManager();
        IJavaElement element = JDTUtils.findElementAtSelection(root, line, column, preferences, monitor);
        IMethod method = null;
        IType type;
        if (element instanceof IMethod m) {
            int flags = m.getFlags();
            if (m.isConstructor() || Flags.isStatic(flags) || Flags.isPrivate(flags) || Flags.isFinal(flags)) return false;
            method = m;
            type = m.getDeclaringType();
        } else if (element instanceof IType t) {
            type = t;
        } else {
            return false;
        }
        if (type == null || type.getJavaProject() == null) return false;
        IRegion sources = JavaCore.newRegion();
        for (IJavaProject project : JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects()) {
            for (IPackageFragmentRoot fragmentRoot : project.getPackageFragmentRoots()) {
                if (fragmentRoot.getKind() == IPackageFragmentRoot.K_SOURCE || isKotlinOutput(fragmentRoot)) {
                    sources.add(fragmentRoot);
                }
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
        return !type.isBinary();
    }

    /** The project's compiled Kotlin classes, attached as a library by the Kotlin bridge. */
    private static boolean isKotlinOutput(IPackageFragmentRoot root) throws JavaModelException {
        if (root.getKind() != IPackageFragmentRoot.K_BINARY) return false;
        IClasspathEntry entry = root.getRawClasspathEntry();
        if (entry == null) return false;
        for (IClasspathAttribute attribute : entry.getExtraAttributes()) {
            if (KOTLIN_OUTPUT.equals(attribute.getName()) && "true".equals(attribute.getValue())) return true;
        }
        return false;
    }
}
