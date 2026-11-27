package ai.openidea.usages;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.ElementChangedEvent;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IJavaElement;
import org.eclipse.jdt.core.IJavaElementDelta;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.managers.ProjectsManager;

/**
 * Answers of `openidea.java.usages` by search targets, kept until a Java element changes: the
 * sources or unsaved edits of a compilation unit, or a project's classpath. A usage count and
 * the usages shown when it is clicked, or the same search run again, then need no new search.
 * Concurrent requests for the same targets share one search.
 */
final class UsageCache {
    private static final int MAX_ENTRIES = 32, MAX_ROWS = 200_000;
    /** Opening or closing an editor's working copy and AST-only reconciles change no usage. */
    private static final int IGNORED_FLAGS = IJavaElementDelta.F_CHILDREN | IJavaElementDelta.F_PRIMARY_WORKING_COPY
            | IJavaElementDelta.F_AST_AFFECTED | IJavaElementDelta.F_FINE_GRAINED;
    private static final AtomicLong REVISION = new AtomicLong();
    private record Entry(long revision, List<Map<String, Object>> rows) {}
    private static final Map<String, Entry> DONE = new LinkedHashMap<>(16, 0.75f, true);
    private static final Map<String, CompletableFuture<List<Map<String, Object>>>> RUNNING = new HashMap<>();

    static {
        JavaCore.addElementChangedListener(event -> {
            if (affects(event.getDelta())) REVISION.incrementAndGet();
        }, ElementChangedEvent.POST_CHANGE | ElementChangedEvent.POST_RECONCILE);
    }

    private UsageCache() {}

    interface Search {
        List<Map<String, Object>> run() throws Exception;
    }

    static boolean affects(IJavaElementDelta delta) {
        // Decompiled library classes open as private working copies; searches never see them.
        if (delta.getElement() instanceof ICompilationUnit unit && unit.getOwner() != null) return false;
        // Files outside the source folders (opened to widen a search) join the default project
        // while open: they are part of the key instead (`openContents`).
        IJavaProject project = delta.getElement().getJavaProject();
        if (project != null && standalone(project)) return false;
        int flags = delta.getFlags() & ~IGNORED_FLAGS;
        if (delta.getElement().getElementType() < IJavaElement.COMPILATION_UNIT) flags &= ~IJavaElementDelta.F_CONTENT;
        if (delta.getKind() != IJavaElementDelta.CHANGED || flags != 0) return true;
        for (IJavaElementDelta child : delta.getAffectedChildren()) if (affects(child)) return true;
        return false;
    }

    static List<Map<String, Object>> get(String targets, IProgressMonitor monitor, Search search) throws Exception {
        // Searches read unsaved editor contents, which change before the reconcile that reports them.
        String key = targets + '|' + openContents(monitor);
        while (true) {
            long revision = REVISION.get();
            CompletableFuture<List<Map<String, Object>>> running;
            boolean owner = false;
            synchronized (UsageCache.class) {
                Entry done = DONE.get(key);
                if (done != null && done.revision == revision) return done.rows;
                running = RUNNING.get(key);
                if (running == null) {
                    running = new CompletableFuture<>();
                    RUNNING.put(key, running);
                    owner = true;
                }
            }
            if (owner) return search(key, revision, running, search);
            // The same targets are searched for another request: its answer, or a new search
            // when that one was cancelled, failed or saw a change.
            while (true) {
                if (monitor.isCanceled()) throw new OperationCanceledException();
                try {
                    List<Map<String, Object>> rows = running.get(50, TimeUnit.MILLISECONDS);
                    if (REVISION.get() == revision) return rows;
                    break;
                } catch (TimeoutException e) {
                    continue;
                } catch (ExecutionException e) {
                    break;
                }
            }
        }
    }

    private static boolean standalone(IJavaProject project) {
        return ProjectsManager.getDefaultProject().equals(project.getProject());
    }

    /** A digest of the editors' unsaved contents and of the open files outside the source
     * folders: merely opening or closing a file of the sources keeps it. */
    private static String openContents(IProgressMonitor monitor) throws Exception {
        Map<String, ICompilationUnit> copies = new TreeMap<>();
        for (ICompilationUnit copy : JavaCore.getWorkingCopies(null)) copies.put(copy.getPrimary().getHandleIdentifier(), copy);
        for (ICompilationUnit copy : JavaCore.getWorkingCopies(JavaLanguageServerPlugin.getInstance().getWorkingCopyOwner()))
            copies.put(copy.getPrimary().getHandleIdentifier(), copy);
        var digest = MessageDigest.getInstance("SHA-256");
        for (var entry : copies.entrySet()) {
            if (monitor.isCanceled()) throw new OperationCanceledException();
            ICompilationUnit copy = entry.getValue();
            if (!copy.hasUnsavedChanges() && !standalone(copy.getJavaProject())) continue;
            digest.update(entry.getKey().getBytes(StandardCharsets.UTF_8));
            String source = entry.getValue().getSource();
            if (source != null) digest.update(source.getBytes(StandardCharsets.UTF_8));
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static List<Map<String, Object>> search(String key, long revision,
            CompletableFuture<List<Map<String, Object>>> running, Search search) throws Exception {
        List<Map<String, Object>> rows;
        try {
            rows = List.copyOf(search.run());
        } catch (Throwable e) {
            synchronized (UsageCache.class) { RUNNING.remove(key); }
            running.completeExceptionally(e);
            throw e;
        }
        synchronized (UsageCache.class) {
            RUNNING.remove(key);
            if (REVISION.get() == revision && rows.size() <= MAX_ROWS) remember(key, new Entry(revision, rows));
        }
        running.complete(rows);
        return rows;
    }

    private static void remember(String key, Entry entry) {
        DONE.put(key, entry);
        int rows = DONE.values().stream().mapToInt(e -> e.rows.size()).sum();
        // Least recently used first; `get` on this access-ordered map would reorder it.
        var oldest = DONE.entrySet().iterator();
        while ((DONE.size() > MAX_ENTRIES || rows > MAX_ROWS) && oldest.hasNext()) {
            var evicted = oldest.next();
            if (evicted.getKey().equals(key)) continue;
            rows -= evicted.getValue().rows.size();
            oldest.remove();
        }
    }
}
