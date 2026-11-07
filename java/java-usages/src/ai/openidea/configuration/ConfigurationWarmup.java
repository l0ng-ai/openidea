package ai.openidea.configuration;

import java.util.*;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.*;
import org.eclipse.core.runtime.jobs.Job;
import org.eclipse.jdt.core.*;

/** One bounded, cooperative queue per language-server process. No polling timer,
 * retained ASTs, or project builds; an ordinary lookup remains the fallback. */
final class ConfigurationWarmup {
    private static final Map<String, IJavaProject> pending = new LinkedHashMap<>();
    private static final Set<String> attempted = new HashSet<>();
    private static final Map<String, Long> completed = new LinkedHashMap<>();
    private static boolean scheduled, stopped;
    private static String active;
    private static final Job job = new Job("Preparing configuration navigation") {
        @Override protected IStatus run(IProgressMonitor monitor) {
            // Compiler defaults/import can schedule a build after ServiceReady.
            // Yield to it instead of blocking a worker on the build job family.
            if (building()) {
                synchronized (ConfigurationWarmup.class) {
                    if (!stopped) schedule(2000);
                    else scheduled = false;
                }
                return Status.OK_STATUS;
            }
            IJavaProject project;
            synchronized (ConfigurationWarmup.class) {
                if (stopped || pending.isEmpty()) { scheduled = false; return Status.OK_STATUS; }
                String id = pending.keySet().iterator().next();
                project = pending.remove(id);
                active = id;
            }
            long deadline = System.nanoTime() + 30_000_000_000L;
            IProgressMonitor bounded = new ProgressMonitorWrapper(monitor) {
                @Override public boolean isCanceled() {
                    return super.isCanceled() || System.nanoTime() >= deadline ||
                            !project.exists() || !project.getProject().isOpen();
                }
            };
            try {
                if (ConfigurationCommand.hasWarmupCapacity(project)) {
                    long build = ConfigurationCommand.warm(project, bounded);
                    synchronized (ConfigurationWarmup.class) {
                        if (completed.size() < 8) completed.put(project.getHandleIdentifier(), build);
                    }
                }
            } catch (OperationCanceledException e) {
                // No partial index is published. A user lookup can retry later.
            } catch (Exception e) {
                org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin.logException("Configuration warmup skipped", e);
            } finally {
                synchronized (ConfigurationWarmup.class) {
                    active = null;
                    if (!stopped && !pending.isEmpty()) schedule(200);
                    else scheduled = false;
                }
            }
            return Status.OK_STATUS;
        }
    };
    static { job.setSystem(true); job.setPriority(Job.DECORATE); }

    private static boolean building() {
        for (Object family : new Object[] { ResourcesPlugin.FAMILY_AUTO_BUILD, ResourcesPlugin.FAMILY_MANUAL_BUILD })
            for (Job other : Job.getJobManager().find(family))
                if (other.getState() != Job.NONE) return true;
        return false;
    }

    static synchronized Object request(List<Object> args) throws JavaModelException {
        String action = args.isEmpty() ? "start" : String.valueOf(args.get(0));
        if (action.equals("cancel")) {
            stopped = true;
            pending.clear();
            job.cancel();
            if (active == null) scheduled = false;
        } else if (action.equals("start") && !stopped) {
            // Open Java buffers identify the user's active modules. Keep those
            // ahead of the rest when the workspace exceeds the cache budget.
            Set<String> open = new HashSet<>();
            for (ICompilationUnit unit : JavaCore.getWorkingCopies(null)) open.add(unit.getJavaProject().getHandleIdentifier());
            for (ICompilationUnit unit : JavaCore.getWorkingCopies(
                    org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin.getInstance().getWorkingCopyOwner()))
                open.add(unit.getJavaProject().getHandleIdentifier());
            Set<String> preferred = new HashSet<>();
            if (args.size() > 1 && args.get(1) instanceof List<?> uris) {
                for (Object uri : uris) if (uri instanceof String text) {
                    IJavaProject project = ConfigurationCommand.project(text);
                    if (project != null) preferred.add(project.getHandleIdentifier());
                }
            }
            List<IJavaProject> projects = new ArrayList<>(Arrays.asList(
                    JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects()));
            projects.sort(Comparator.comparing((IJavaProject p) -> !preferred.contains(p.getHandleIdentifier()))
                    .thenComparing(p -> !open.contains(p.getHandleIdentifier()))
                    .thenComparing(IJavaProject::getElementName));
            for (IJavaProject project : projects) {
                String id = project.getHandleIdentifier();
                if (project.getProject().isOpen() && !attempted.contains(id) && pending.size() < 64) {
                    attempted.add(id);
                    pending.put(id, project);
                }
            }
            if (!scheduled && !pending.isEmpty()) { scheduled = true; job.schedule(2000); }
        }
        return Map.of("scheduled", scheduled, "pending", pending.size(), "active", active == null ? "" : active,
                "completed", new LinkedHashMap<>(completed));
    }
}
