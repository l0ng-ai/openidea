package ai.openidea.usages;

import java.util.ArrayList;
import java.util.List;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.IClasspathEntry;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.IPackageFragmentRoot;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.search.IJavaSearchScope;
import org.eclipse.jdt.core.search.SearchEngine;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.managers.ProjectsManager;
import org.eclipse.jdt.ls.core.internal.preferences.Preferences.SearchScope;

/**
 * Directories whose Java files are all in the workspace's semantic source searches: source
 * folders without inclusion or exclusion patterns that the search scope encloses. A client
 * looking for files beyond that scope need not read the files under them.
 */
public final class CoveredRootsCommand implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        IJavaProject[] projects = JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects();
        var setting = JavaLanguageServerPlugin.getPreferencesManager().getPreferences().getSearchScope();
        var scope = SearchEngine.createJavaSearchScope(setting == SearchScope.main, projects,
                IJavaSearchScope.SOURCES | IJavaSearchScope.REFERENCED_PROJECTS);
        List<String> covered = new ArrayList<>();
        for (IJavaProject project : projects) {
            // The default project holds standalone open files, not an indexed source tree.
            if (ProjectsManager.getDefaultProject().equals(project.getProject())) continue;
            for (IPackageFragmentRoot root : project.getPackageFragmentRoots()) {
                if (monitor.isCanceled()) throw new OperationCanceledException();
                if (root.getKind() != IPackageFragmentRoot.K_SOURCE || root.getResource() == null) continue;
                IClasspathEntry entry = root.getRawClasspathEntry();
                if (entry == null || entry.getExclusionPatterns().length > 0) continue;
                // Maven projects include `**/*.java`: every Java file, like no pattern at all.
                boolean allJava = true;
                for (var pattern : entry.getInclusionPatterns()) allJava &= pattern.toString().equals("**/*.java");
                if (!allJava) continue;
                if (!scope.encloses(root)) continue;
                var location = root.getResource().getLocationURI();
                if (location != null) covered.add(location.toString());
            }
        }
        return covered;
    }
}
