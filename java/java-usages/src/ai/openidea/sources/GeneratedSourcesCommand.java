package ai.openidea.sources;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.core.resources.IFolder;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.core.runtime.Path;
import org.eclipse.jdt.core.IClasspathAttribute;
import org.eclipse.jdt.core.IClasspathEntry;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;

/**
 * Adds Maven plugin output (protobuf, gRPC, jOOQ, …) as source folders.
 *
 * <p>The argument is {@code [{path, test}, …]}: absolute directories the build already
 * generated. Folders this command added are marked {@code openidea.generatedSource} and
 * dropped again when they are no longer in that list, so a later reload does not keep a
 * source folder Maven has cleaned. Entries m2e or build-helper already created are left
 * as they are.
 */
public final class GeneratedSourcesCommand implements IDelegateCommandHandler {
    static final String MARKER = "openidea.generatedSource";
    private static final String MAVEN = "org.eclipse.m2e.core.maven2Nature";

    private record Spec(IPath path, boolean test) {}

    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        List<Spec> specs = specs(arguments);
        IJavaProject[] projects = JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects();
        int changed = 0;
        for (IJavaProject project : projects) {
            if (monitor.isCanceled()) throw new OperationCanceledException();
            if (!isMaven(project)) continue;
            if (sync(project, owned(projects, project, specs), monitor)) changed++;
        }
        return changed;
    }

    private static List<Spec> specs(List<Object> arguments) {
        List<Spec> specs = new ArrayList<>();
        if (arguments == null) return specs;
        for (Object argument : arguments) {
            if (!(argument instanceof Map<?, ?> map)) continue;
            if (!(map.get("path") instanceof String path) || path.isBlank()) continue;
            specs.add(new Spec(Path.fromOSString(path), Boolean.TRUE.equals(map.get("test"))));
        }
        return specs;
    }

    /** Specs whose longest Maven project prefix is `project`. A reactor parent also prefixes its modules. */
    private static List<Spec> owned(IJavaProject[] projects, IJavaProject project, List<Spec> specs) {
        IPath location = project.getProject().getLocation();
        List<Spec> owned = new ArrayList<>();
        if (location == null) return owned;
        for (Spec spec : specs) {
            if (!location.isPrefixOf(spec.path)) continue;
            IJavaProject best = project;
            int segments = location.segmentCount();
            for (IJavaProject other : projects) {
                if (other == project || !isMaven(other)) continue;
                IPath otherLocation = other.getProject().getLocation();
                if (otherLocation != null && otherLocation.isPrefixOf(spec.path)
                        && otherLocation.segmentCount() > segments) {
                    best = other;
                    segments = otherLocation.segmentCount();
                }
            }
            if (best == project) owned.add(spec);
        }
        return owned;
    }

    private static boolean sync(IJavaProject project, List<Spec> specs, IProgressMonitor monitor) {
        try {
            IPath location = project.getProject().getLocation();
            if (location == null) return false;
            Map<IPath, Boolean> wanted = new LinkedHashMap<>();
            for (Spec spec : specs) {
                if (monitor.isCanceled()) throw new OperationCanceledException();
                IPath relative = spec.path.makeRelativeTo(location);
                if (relative.isAbsolute() || relative.segmentCount() == 0) continue;
                IFolder folder = project.getProject().getFolder(relative);
                refresh(folder, monitor);
                if (folder.exists()) wanted.put(project.getPath().append(relative), spec.test);
            }
            IClasspathEntry[] raw = project.getRawClasspath();
            List<IClasspathEntry> next = new ArrayList<>();
            boolean changed = false;
            for (IClasspathEntry entry : raw) {
                if (!marked(entry)) {
                    next.add(entry);
                    continue;
                }
                if (wanted.containsKey(entry.getPath())) next.add(entry);
                else changed = true;
            }
            for (Map.Entry<IPath, Boolean> entry : wanted.entrySet()) {
                if (hasSource(next, entry.getKey())) continue;
                IClasspathAttribute[] attributes = entry.getValue()
                        ? new IClasspathAttribute[] {
                            JavaCore.newClasspathAttribute(IClasspathAttribute.TEST, "true"),
                            JavaCore.newClasspathAttribute(MARKER, "true")
                        }
                        : new IClasspathAttribute[] { JavaCore.newClasspathAttribute(MARKER, "true") };
                next.add(JavaCore.newSourceEntry(entry.getKey(), new IPath[0], new IPath[0], null, attributes));
                changed = true;
            }
            if (!changed) return false;
            project.setRawClasspath(next.toArray(IClasspathEntry[]::new), monitor);
            return true;
        } catch (CoreException | OperationCanceledException e) {
            JavaLanguageServerPlugin.logException("Adding generated Maven sources to " + project.getElementName(), e);
            return false;
        }
    }

    private static void refresh(IFolder folder, IProgressMonitor monitor) throws CoreException {
        IResource resource = folder;
        while (resource.getType() != IResource.ROOT && !resource.exists()) {
            IResource parent = resource.getParent();
            if (parent == null) return;
            resource = parent;
        }
        resource.refreshLocal(IResource.DEPTH_INFINITE, monitor);
    }

    private static boolean marked(IClasspathEntry entry) {
        if (entry.getEntryKind() != IClasspathEntry.CPE_SOURCE) return false;
        for (IClasspathAttribute attribute : entry.getExtraAttributes()) {
            if (MARKER.equals(attribute.getName()) && "true".equals(attribute.getValue())) return true;
        }
        return false;
    }

    private static boolean hasSource(List<IClasspathEntry> entries, IPath path) {
        for (IClasspathEntry entry : entries) {
            if (entry.getEntryKind() == IClasspathEntry.CPE_SOURCE && entry.getPath().equals(path)) return true;
        }
        return false;
    }

    private static boolean isMaven(IJavaProject project) {
        IProject resource = project.getProject();
        try {
            return resource.isAccessible() && resource.hasNature(MAVEN);
        } catch (CoreException e) {
            return false;
        }
    }
}
