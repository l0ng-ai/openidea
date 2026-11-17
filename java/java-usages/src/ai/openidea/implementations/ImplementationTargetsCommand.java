package ai.openidea.implementations;

import ai.openidea.Documents;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.internal.corext.util.MethodOverrideTester;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.lsp4j.Location;

/**
 * Where the implementations of the method at a position declare it, in the classes named by the
 * caller: one location per target URI, or null when the target has no such method. The standard
 * implementation request answers with the start of a class file's decompiled source for an
 * implementation in a dependency; this resolves the method's own declaration there.
 */
public final class ImplementationTargetsCommand implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        Documents.awaitChanges(monitor);
        String uri = (String) arguments.get(0);
        int line = ((Number) arguments.get(1)).intValue();
        int column = ((Number) arguments.get(2)).intValue();
        @SuppressWarnings("unchecked")
        List<String> targets = (List<String>) arguments.get(3);
        ITypeRoot root = JDTUtils.resolveTypeRoot(uri, true, monitor);
        if (root == null) return Map.of("locations", List.of());
        try {
            var preferences = JavaLanguageServerPlugin.getPreferencesManager();
            IJavaElement element = JDTUtils.findElementAtSelection(root, line, column, preferences, monitor);
            if (!(element instanceof IMethod method)) return Map.of("locations", List.of());
            List<Location> locations = new ArrayList<>(targets.size());
            for (String targetUri : targets) {
                if (monitor.isCanceled()) throw new OperationCanceledException();
                locations.add(find(method, targetUri, monitor));
            }
            return Map.of("locations", locations);
        } finally {
            JDTUtils.discardClassFileWorkingCopy(root);
        }
    }

    /** The declaration of {@code method}'s implementation in the class {@code targetUri}, or null. */
    private static Location find(IMethod method, String targetUri, IProgressMonitor monitor) throws JavaModelException {
        ITypeRoot targetRoot = JDTUtils.resolveTypeRoot(targetUri);
        if (targetRoot == null) return null;
        IType target = targetRoot.findPrimaryType();
        if (target == null) return null;
        ITypeHierarchy hierarchy = target.newSupertypeHierarchy(monitor);
        // Seen from the subtype, so its type arguments substitute the method's type variables.
        IMethod found = new MethodOverrideTester(target, hierarchy).findOverridingMethodInType(target, method);
        if (found == null || Flags.isAbstract(found.getFlags())) return null;
        IClassFile classFile = found.getClassFile();
        if (classFile == null) return JDTUtils.toLocation(found);
        List<Location> decompiled = JDTUtils.searchDecompiledSources(found, classFile, true, true, monitor);
        return decompiled.isEmpty() ? null : decompiled.get(0);
    }
}
