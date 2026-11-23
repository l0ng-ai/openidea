package ai.openidea.archives;

import java.lang.reflect.Field;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.core.runtime.Path;
import org.eclipse.jdt.core.IJavaModel;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.IPackageFragmentRoot;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.ProjectUtils;
import org.eclipse.lsp4j.TextDocumentIdentifier;

/**
 * Re-reads library archives replaced in place (a SNAPSHOT installed again keeps its path). The
 * arguments are the archives' file system paths. Their package fragment roots are closed, which
 * drops the class files read from the old archive, and jdtls' decompiled sources (cached by class
 * handle, which a replaced archive keeps) are dropped, so the classes are read again.
 */
public final class RefreshArchivesCommand implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        if ("openidea.java.updateProjectConfigurations".equals(command)) {
            List<TextDocumentIdentifier> files = arguments.stream()
                    .filter(String.class::isInstance)
                    .map(uri -> new TextDocumentIdentifier((String) uri))
                    .toList();
            Collection<IProject> projects = ProjectUtils.getProjectsFromDocumentIdentifiers(files);
            if (!projects.isEmpty()) {
                JavaLanguageServerPlugin.getProjectsManager().updateProjects(projects, true).join(0, monitor);
            }
            return null;
        }
        IJavaModel model = JavaCore.create(ResourcesPlugin.getWorkspace().getRoot());
        model.refreshExternalArchives(null, monitor);
        Set<IPath> archives = new HashSet<>();
        for (Object argument : arguments) {
            if (argument instanceof String path) archives.add(Path.fromOSString(path));
        }
        int closed = 0;
        if (archives.isEmpty()) return closed;
        clearDecompilerCache();
        for (IJavaProject project : model.getJavaProjects()) {
            for (IPackageFragmentRoot root : project.getPackageFragmentRoots()) {
                if (monitor.isCanceled()) throw new OperationCanceledException();
                if (root.isArchive() && root.isExternal() && archives.contains(root.getPath()) && root.isOpen()) {
                    root.close();
                    closed++;
                }
            }
        }
        return closed;
    }

    /** jdtls keeps decompiled sources in a static per-decompiler LRU with no API to drop them. */
    private static void clearDecompilerCache() {
        try {
            Class<?> impl = IDelegateCommandHandler.class.getClassLoader()
                    .loadClass("org.eclipse.jdt.ls.core.internal.decompiler.DecompilerImpl");
            Field field = impl.getDeclaredField("decompilerCache");
            field.setAccessible(true);
            if (field.get(null) instanceof Map<?, ?> caches) {
                synchronized (caches) {
                    for (Object cache : caches.values()) {
                        if (cache instanceof Map<?, ?> map) map.clear();
                    }
                }
            }
        } catch (ReflectiveOperationException | RuntimeException e) {
            JavaLanguageServerPlugin.logException("Clearing decompiled sources", e);
        }
    }
}
