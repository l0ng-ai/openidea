package ai.openidea.usages;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.search.IJavaSearchConstants;
import org.eclipse.jdt.core.search.IJavaSearchScope;
import org.eclipse.jdt.core.search.SearchEngine;
import org.eclipse.jdt.core.search.SearchMatch;
import org.eclipse.jdt.core.search.SearchParticipant;
import org.eclipse.jdt.core.search.SearchPattern;
import org.eclipse.jdt.core.search.SearchRequestor;
import org.eclipse.jdt.internal.corext.codemanipulation.GetterSetterUtil;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.SearchUtils;
import org.eclipse.jdt.ls.core.internal.handlers.JsonRpcHelpers;
import org.eclipse.jdt.ls.core.internal.handlers.ReferencesHandler;
import org.eclipse.jdt.ls.core.internal.preferences.Preferences.SearchScope;
import org.eclipse.lsp4j.*;

/** Classifies search results using JDT method identities, never reference text. */
public final class UsagesCommand implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        String uri = (String) arguments.get(0);
        int line = ((Number) arguments.get(1)).intValue();
        int column = ((Number) arguments.get(2)).intValue();
        boolean declarations = Boolean.TRUE.equals(arguments.get(3));
        // "sources": the workspace's source folders only, without dependency jars or the JDK. A
        // library method's usages there are found long before the full search ends.
        boolean sources = arguments.size() > 4 && "sources".equals(arguments.get(4));
        var preferences = JavaLanguageServerPlugin.getPreferencesManager();
        var handler = new ReferencesHandler(preferences);
        // The verified server's search is replicated (see `search`); others keep their own.
        boolean replicated = sources || NATIVE_PLAN_SUPPORTED;
        Search search = replicated ? (element, locations, m, d) -> search(element, locations, m, d, sources) : handler::search;
        var params = new ReferenceParams(new TextDocumentIdentifier(uri), new Position(line, column), new ReferenceContext(declarations));
        Map<Location, String> results = new LinkedHashMap<>();
        ITypeRoot root = JDTUtils.resolveTypeRoot(uri);
        IJavaElement selected = root == null ? null :
                JDTUtils.findElementAtSelection(root, line, column, preferences, monitor);
        if (monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
        boolean accessors = preferences.getPreferences().isIncludeAccessors();
        SearchPlan plan = new SearchPlan();
        ITypeRoot targetRoot = null;
        try {
            // Only replace native target discovery for the exact implementation verified by
            // integration tests. New server implementations retain their full native behavior.
            if (selected instanceof IField field && root instanceof ICompilationUnit &&
                    root.getResource() != null && NATIVE_PLAN_SUPPORTED) {
                plan.add(field, "field", declarations);
                if (accessors) {
                    plan.add(GetterSetterUtil.getGetter(field), "getter", false);
                    plan.add(GetterSetterUtil.getSetter(field), "setter", false);
                    addNativeBuilderTargets(handler, field, plan);
                    addConfiguredAccessors(field, plan);
                }
            } else if (replicated) {
                // Non-fields and library/decompiled roots: the target ReferencesHandler.findReferences
                // resolves (a class file without source through its decompiled working copy), widened
                // as it widens a field.
                boolean decompiled = preferences.isClientSupportsClassFileContent() && preferences.getPreferences().isIncludeDecompiledSources();
                targetRoot = JDTUtils.resolveTypeRoot(uri, decompiled, monitor);
                IJavaElement target = targetRoot == null ? null :
                        JDTUtils.findElementAtSelection(targetRoot, line, column, preferences, monitor);
                if (target == null && targetRoot != null) {
                    target = targetRoot.getElementAt(JsonRpcHelpers.toOffset(targetRoot.getBuffer(), line, column));
                }
                plan.add(target, target instanceof IField ? "field" : "unknown", declarations);
                if (accessors && target instanceof IField field) {
                    plan.add(GetterSetterUtil.getGetter(field), "getter", false);
                    plan.add(GetterSetterUtil.getSetter(field), "setter", false);
                    if (NATIVE_PLAN_SUPPORTED) addNativeBuilderTargets(handler, field, plan);
                    addConfiguredAccessors(field, plan);
                }
            } else {
                // Unverified JDT LS builds.
                for (var location : handler.findReferences(params, monitor)) results.put(location, "unknown");
                if (selected instanceof IField field) {
                    plan.add(field, "field", declarations);
                    if (accessors) {
                        plan.add(GetterSetterUtil.getGetter(field), "getter", false);
                        plan.add(GetterSetterUtil.getSetter(field), "setter", false);
                        addConfiguredAccessors(field, plan);
                    }
                }
            }
            for (var target : plan.targets.values()) {
                if (monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
                add(search, target.element, target.kind(), target.declarations, results, monitor);
            }
        } finally {
            if (targetRoot != null) JDTUtils.discardClassFileWorkingCopy(targetRoot);
        }
        if (monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
        List<Map<String, Object>> response = new ArrayList<>();
        UsageAccess access = new UsageAccess(monitor, results);
        Map<String, String[]> libraryLines = new java.util.HashMap<>();
        for (var entry : results.entrySet()) {
            if (monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
            Location location = entry.getKey();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("location", location);
            row.put("kind", entry.getValue());
            row.put("access", access.classify(location, entry.getValue()));
            String text = libraryLine(location, libraryLines, monitor);
            if (text != null) row.put("text", text);
            response.add(row);
        }
        return response;
    }

    /**
     * The line of a usage in a library class (`jdt:` URI), from the contents the client would
     * request for it: so the client need not fetch thousands of class files to show the lines.
     */
    private static String libraryLine(Location location, Map<String, String[]> cache, IProgressMonitor monitor) {
        String uri = location.getUri();
        if (uri == null || !uri.startsWith("jdt:")) return null;
        if (!cache.containsKey(uri)) {
            String contents = null;
            try {
                contents = JavaLanguageServerPlugin.getContentProviderManager().getContent(JDTUtils.toURI(uri), monitor);
            } catch (RuntimeException e) {
                if (e instanceof org.eclipse.core.runtime.OperationCanceledException) throw e;
            }
            cache.put(uri, contents == null ? null : contents.split("\\r\\n?|\\n", -1));
        }
        String[] lines = cache.get(uri);
        int line = location.getRange().getStart().getLine();
        return lines != null && line >= 0 && line < lines.length ? lines[line] : null;
    }

    /** Resolve explicit Lombok @Accessors naming, then search exact JDT method identities.
     * Configuration-file-only naming is deliberately not guessed.
     */
    private static void addConfiguredAccessors(IField field, SearchPlan plan) throws Exception {
        Boolean fluent = null;
        boolean configured = false;
        String[] prefixes = null;
        // Field annotations override enclosing type annotations, as Lombok does.
        List<IAnnotatable> owners = new ArrayList<>();
        owners.add(field);
        for (IType type = field.getDeclaringType(); type != null; type = type.getDeclaringType()) owners.add(type);
        for (IAnnotatable owner : owners) {
            for (IAnnotation annotation : owner.getAnnotations()) {
                String name = annotation.getElementName();
                if (!name.equals("Accessors") && !name.equals("lombok.experimental.Accessors")) continue;
                String[][] resolved = field.getDeclaringType().resolveType(name);
                if (!name.equals("lombok.experimental.Accessors") && (resolved == null || resolved.length != 1 ||
                        !resolved[0][0].equals("lombok.experimental") || !resolved[0][1].equals("Accessors"))) continue;
                configured = true;
                for (IMemberValuePair pair : annotation.getMemberValuePairs()) {
                    if (pair.getMemberName().equals("fluent") && fluent == null && pair.getValue() instanceof Boolean value) fluent = value;
                    if (pair.getMemberName().equals("prefix") && prefixes == null) {
                        Object value = pair.getValue();
                        if (value instanceof String prefix) prefixes = new String[] { prefix };
                        else if (value instanceof Object[] values) {
                            prefixes = new String[values.length];
                            for (int i = 0; i < values.length; i++) prefixes[i] = (String) values[i];
                        }
                    }
                }
            }
        }
        if (!configured) return;
        String name = field.getElementName();
        if (prefixes != null && prefixes.length > 0) {
            String stripped = null;
            for (String prefix : prefixes) {
                if (prefix.isEmpty()) { stripped = name; break; }
                if (!name.startsWith(prefix) || name.length() == prefix.length()) continue;
                char next = name.charAt(prefix.length());
                if (Character.isLetter(prefix.charAt(prefix.length() - 1)) && Character.isLowerCase(next)) continue;
                stripped = Character.toLowerCase(next) + name.substring(prefix.length() + 1);
                break;
            }
            if (stripped == null) return;
            name = stripped;
        }
        String signature = field.getTypeSignature();
        String getterName = name;
        String setterName = name;
        if (!Boolean.TRUE.equals(fluent)) {
            boolean bool = signature.equals(Signature.SIG_BOOLEAN);
            String base = name;
            if (bool && base.startsWith("is") && base.length() > 2 && Character.isUpperCase(base.charAt(2))) base = base.substring(2);
            String capital = Character.toUpperCase(base.charAt(0)) + base.substring(1);
            getterName = (bool ? "is" : "get") + capital;
            setterName = "set" + capital;
        }
        for (IMethod method : field.getDeclaringType().getMethods()) {
            if (Flags.isStatic(method.getFlags()) != Flags.isStatic(field.getFlags())) continue;
            if (method.getElementName().equals(getterName) && method.getNumberOfParameters() == 0 && method.getReturnType().equals(signature)) {
                plan.add(method, "getter", false);
            } else if (method.getElementName().equals(setterName) && method.getNumberOfParameters() == 1 && method.getParameterTypes()[0].equals(signature) && setterReturnType(method)) {
                plan.add(method, "setter", false);
            }
        }
    }

    private static final boolean NATIVE_PLAN_SUPPORTED = nativePlanSupported();

    private static boolean nativePlanSupported() {
        // JDT LS 1.63.0.202610191322 ReferencesHandler.class. Fingerprinting guards
        // against silently dropping new native search targets in future versions.
        try (var stream = ReferencesHandler.class.getResourceAsStream("ReferencesHandler.class")) {
            if (stream == null) return false;
            String digest = java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(stream.readAllBytes()));
            return digest.equals("31ff5a10c7d69d58c6a9b619ef17e3ec41b11b545751ba428618a76cc1341064");
        } catch (Exception e) {
            return false;
        }
    }

    private static void addNativeBuilderTargets(ReferencesHandler handler, IField field, SearchPlan plan) throws Exception {
        // Reuse the verified server's own builder naming (including custom names).
        var resolver = ReferencesHandler.class.getDeclaredMethod("getBuilderName", IField.class);
        resolver.setAccessible(true);
        String name = (String) resolver.invoke(handler, field);
        IType builder = field.getJavaProject().findType(name);
        if (builder == null) return;
        for (IMethod method : builder.getMethods()) {
            String[] parameters = method.getParameterTypes();
            if (parameters.length == 1 && field.getElementName().equals(method.getElementName()) &&
                    field.getTypeSignature().equals(parameters[0])) plan.add(method, "unknown", false);
        }
    }

    private static final class SearchTarget {
        final IJavaElement element;
        final java.util.Set<String> kinds = new java.util.HashSet<>();
        boolean declarations;
        SearchTarget(IJavaElement element) { this.element = element; }
        String kind() { return kinds.size() == 1 ? kinds.iterator().next() : "unknown"; }
    }

    private static final class SearchPlan {
        final Map<IJavaElement, SearchTarget> targets = new LinkedHashMap<>();
        void add(IJavaElement element, String kind, boolean declarations) {
            if (element == null) return;
            SearchTarget target = targets.computeIfAbsent(element, SearchTarget::new);
            if (!kind.equals("unknown")) target.kinds.add(kind);
            target.declarations |= declarations;
        }
    }

    private static boolean setterReturnType(IMethod method) throws JavaModelException {
        String result = method.getReturnType();
        if (result.equals(Signature.SIG_VOID)) return true;
        String name = Signature.toString(Signature.getTypeErasure(result));
        IType owner = method.getDeclaringType();
        if (name.equals(owner.getFullyQualifiedName())) return true;
        String[][] resolved = owner.resolveType(name);
        return resolved != null && resolved.length == 1 &&
            (resolved[0][0].isEmpty() ? resolved[0][1] : resolved[0][0] + "." + resolved[0][1]).equals(owner.getFullyQualifiedName());
    }

    private interface Search {
        void run(IJavaElement element, List<Location> locations, IProgressMonitor monitor, boolean declarations) throws Exception;
    }

    /**
     * ReferencesHandler.search of the verified server, except that a class file whose decompiled
     * source fails to parse loses only its own matches: there the server throws and fails the
     * whole search, after searching most of the dependencies. `sources`: the workspace's source
     * folders only, without dependency jars and the JDK.
     */
    private static void search(IJavaElement element, List<Location> locations, IProgressMonitor monitor,
            boolean declarations, boolean sources) throws CoreException {
        SearchPattern pattern = SearchPattern.createPattern(element, IJavaSearchConstants.REFERENCES);
        if (pattern == null) return;
        if (declarations) {
            SearchPattern declaration = SearchPattern.createPattern(element, IJavaSearchConstants.DECLARATIONS);
            if (declaration != null) pattern = SearchPattern.createOrPattern(pattern, declaration);
        }
        var preferences = JavaLanguageServerPlugin.getPreferencesManager();
        SearchScope setting = preferences.getPreferences().getSearchScope();
        int mask = IJavaSearchScope.SOURCES | IJavaSearchScope.REFERENCED_PROJECTS;
        if (!sources && setting != SearchScope.projectOnly) {
            mask |= IJavaSearchScope.APPLICATION_LIBRARIES;
            if (insideJre(element)) mask |= IJavaSearchScope.SYSTEM_LIBRARIES;
        }
        IJavaProject[] projects = JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects();
        IJavaSearchScope scope = SearchEngine.createJavaSearchScope(setting == SearchScope.main, projects, mask);
        boolean classFiles = preferences.isClientSupportsClassFileContent();
        boolean decompiled = preferences.getPreferences().isIncludeDecompiledSources();
        new SearchEngine().search(pattern, new SearchParticipant[] { SearchEngine.getDefaultSearchParticipant() }, scope,
                new SearchRequestor() {
                    @Override
                    public void acceptSearchMatch(SearchMatch match) throws CoreException {
                        if (match.getAccuracy() == SearchMatch.A_INACCURATE || !(match.getElement() instanceof IJavaElement found)) return;
                        if (found.getAncestor(IJavaElement.COMPILATION_UNIT) instanceof ICompilationUnit unit) {
                            locations.add(JDTUtils.toLocation(unit, match.getOffset(), match.getLength()));
                            return;
                        }
                        if (!classFiles || !(found.getAncestor(IJavaElement.CLASS_FILE) instanceof IClassFile classFile)) return;
                        if (classFile.getSourceRange() != null) {
                            locations.add(JDTUtils.toLocation(classFile, match.getOffset(), match.getLength()));
                            return;
                        }
                        if (!decompiled) return;
                        try {
                            if (found instanceof IMember member) {
                                Location location = SearchUtils.searchOtherSources(member);
                                if (location != null) locations.add(location);
                            }
                            locations.addAll(JDTUtils.searchDecompiledSources(found, classFile, false, false, monitor));
                        } catch (org.eclipse.core.runtime.OperationCanceledException e) {
                            throw e;
                        } catch (RuntimeException | CoreException e) {
                            JavaLanguageServerPlugin.logInfo("Usages in decompiled " + classFile.getElementName() + " skipped: " + e);
                        }
                    }
                }, monitor);
    }

    /** ReferencesHandler.isInsideJRE: a JDK element is searched in the JDK too. */
    private static boolean insideJre(IJavaElement element) {
        if (!(element.getAncestor(IJavaElement.PACKAGE_FRAGMENT_ROOT) instanceof IPackageFragmentRoot root)) return true;
        try {
            IClasspathEntry entry = root.getRawClasspathEntry();
            if (entry.getEntryKind() != IClasspathEntry.CPE_CONTAINER) return false;
            IClasspathContainer container = JavaCore.getClasspathContainer(entry.getPath(), root.getJavaProject());
            return container != null && container.getKind() == IClasspathContainer.K_DEFAULT_SYSTEM;
        } catch (JavaModelException e) {
            JavaLanguageServerPlugin.logException(e);
            return true;
        }
    }

    private static void add(Search search, IJavaElement element, String kind, boolean declarations,
            Map<Location, String> results, IProgressMonitor monitor) throws Exception {
        if (element == null) return;
        List<Location> locations = new ArrayList<>();
        search.run(element, locations, monitor, declarations);
        for (var location : locations) {
            if (kind.equals("unknown")) { results.putIfAbsent(location, kind); continue; }
            String previous = results.get(location);
            results.put(location, previous == null || previous.equals("unknown") || previous.equals(kind) ? kind : "unknown");
        }
    }
}
