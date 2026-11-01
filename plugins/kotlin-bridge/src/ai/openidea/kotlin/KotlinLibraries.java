package ai.openidea.kotlin;

import com.google.gson.Gson;
import java.io.File;
import java.net.URI;
import java.util.*;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.*;
import org.eclipse.core.runtime.jobs.Job;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;

/** Owns only marked binary entries; Maven and user entries retain their identities. */
public final class KotlinLibraries implements IDelegateCommandHandler {
    private static final String OWNER = "ai.openidea.kotlin";
    private static final Object LOCK = new Object();
    private static List<ProjectLibraries> desired = List.of();
    private static boolean listening;
    private static final Job reconcileJob = new Job("Kotlin binary libraries") {
        @Override protected IStatus run(IProgressMonitor monitor) {
            synchronized (LOCK) {
                try {
                    reconcile(monitor);
                    return Status.OK_STATUS;
                } catch (CoreException e) {
                    return e.getStatus();
                }
            }
        }
    };
    private static class Library { String path; boolean test; }
    private static class ProjectLibraries { String projectUri; List<Library> libraries; }

    @Override public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        if (!"openidea.kotlin.replace".equals(command) || arguments.size() != 1)
            throw new IllegalArgumentException("Expected one Kotlin library snapshot");
        Gson gson = new Gson();
        ProjectLibraries[] snapshot = gson.fromJson(gson.toJson(arguments.get(0)), ProjectLibraries[].class);
        for (ProjectLibraries project : snapshot) {
            new File(URI.create(project.projectUri));
            for (Library library : project.libraries) {
                if (!new File(library.path).isAbsolute() || !new File(library.path).isDirectory())
                    throw new IllegalArgumentException("Kotlin library must be a published directory: " + library.path);
            }
        }
        synchronized (LOCK) {
            if (monitor.isCanceled()) throw new OperationCanceledException();
            desired = List.of(snapshot);
            if (!listening) {
                JavaCore.addElementChangedListener(event -> reconcileJob.schedule(200), ElementChangedEvent.POST_CHANGE);
                listening = true;
            }
            return reconcile(monitor);
        }
    }

    private static File canonical(URI uri) {
        File file = new File(uri);
        try { return file.getCanonicalFile(); }
        catch (java.io.IOException e) { return file.getAbsoluteFile(); }
    }

    private static int reconcile(IProgressMonitor monitor) throws CoreException {
        int changed = 0;
        for (IJavaProject project : JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects()) {
            if (!project.getProject().isAccessible()) continue;
            List<IClasspathEntry> entries = new ArrayList<>();
            IClasspathEntry[] original = project.getRawClasspath();
            for (IClasspathEntry entry : original) {
                boolean owned = entry.getEntryKind() == IClasspathEntry.CPE_LIBRARY &&
                    Arrays.stream(entry.getExtraAttributes()).anyMatch(a -> OWNER.equals(a.getName()) && "true".equals(a.getValue()));
                if (!owned) entries.add(entry);
            }
            URI location = project.getProject().getLocationURI();
            for (ProjectLibraries item : desired) {
                if (location == null || !canonical(location).equals(canonical(URI.create(item.projectUri)))) continue;
                for (Library library : item.libraries) {
                    List<IClasspathAttribute> attributes = new ArrayList<>();
                    attributes.add(JavaCore.newClasspathAttribute(OWNER, "true"));
                    if (library.test) attributes.add(JavaCore.newClasspathAttribute(IClasspathAttribute.TEST, "true"));
                    entries.add(JavaCore.newLibraryEntry(Path.fromOSString(library.path), null, null,
                        new IAccessRule[0], attributes.toArray(IClasspathAttribute[]::new), false));
                }
            }
            IClasspathEntry[] updated = entries.toArray(IClasspathEntry[]::new);
            if (!Arrays.equals(original, updated)) {
                if (monitor.isCanceled()) throw new OperationCanceledException();
                project.setRawClasspath(updated, monitor);
                changed++;
            }
        }
        return changed;
    }
}
