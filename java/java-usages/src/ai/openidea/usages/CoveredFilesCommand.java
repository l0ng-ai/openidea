package ai.openidea.usages;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.search.IJavaSearchScope;
import org.eclipse.jdt.core.search.SearchEngine;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.managers.ProjectsManager;
import org.eclipse.jdt.ls.core.internal.preferences.Preferences.SearchScope;

/** Candidate files already included in the workspace's semantic source searches. */
public final class CoveredFilesCommand implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        var workspace = ResourcesPlugin.getWorkspace().getRoot();
        IJavaProject[] projects = JavaCore.create(workspace).getJavaProjects();
        var setting = JavaLanguageServerPlugin.getPreferencesManager().getPreferences().getSearchScope();
        var scope = SearchEngine.createJavaSearchScope(setting == SearchScope.main, projects,
                IJavaSearchScope.SOURCES | IJavaSearchScope.REFERENCED_PROJECTS);
        List<String> covered = new ArrayList<>();
        for (Object candidate : (List<?>) arguments.get(0)) {
            if (monitor.isCanceled()) throw new OperationCanceledException();
            String uri = (String) candidate;
            for (var file : workspace.findFilesForLocationURI(URI.create(uri))) {
                if (!(JavaCore.create(file) instanceof ICompilationUnit unit) || !unit.exists()) continue;
                IJavaProject project = unit.getJavaProject();
                // The default project holds standalone open files, not an indexed source tree.
                if (ProjectsManager.getDefaultProject().equals(project.getProject()) || !project.isOnClasspath(file)) continue;
                if (scope.encloses(unit)) {
                    covered.add(uri);
                    break;
                }
            }
        }
        return covered;
    }
}
