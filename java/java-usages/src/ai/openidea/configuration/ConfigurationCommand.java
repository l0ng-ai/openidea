package ai.openidea.configuration;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import java.util.zip.ZipFile;
import com.google.gson.*;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.dom.*;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.handlers.ReferencesHandler;
import org.eclipse.lsp4j.Location;

/** On-demand configuration index, scoped by JDT's resolved source/class path.
 * Cached records contain strings and locations, never ASTs or bindings. Java model
 * changes invalidate snapshots, including unsaved working copies and classpath edits.
 */
public final class ConfigurationCommand implements IDelegateCommandHandler {
    private static final String PROPERTIES = "org.springframework.boot.context.properties.ConfigurationProperties";
    private static final String VALUE = "org.springframework.beans.factory.annotation.Value";
    private static final String RESOLVER = "org.springframework.core.env.PropertyResolver";
    private static final int MAX_UNITS = 20_000, MAX_ENTRIES = 100_000, MAX_BYTES = 2 * 1024 * 1024;
    private static final AtomicLong REVISION = new AtomicLong(), GENERATION = new AtomicLong();
    private static final Map<String, Index> CACHE = new LinkedHashMap<>();
    /** One build per project at a time; waiting lookups stay cancellable. */
    private static final Map<String, ReentrantLock> LOCKS = new ConcurrentHashMap<>();
    /** Unsaved edits are covered by the working-copy digest, so reconciles never
     * invalidate. Opening/closing a working copy (F_PRIMARY_WORKING_COPY) and
     * non-Java resources, reported as F_CONTENT on a project, root or package
     * (configuration files are parsed by the client; metadata files carry their
     * own stamps), do not change the index either. */
    private static final int IGNORED_FLAGS = IJavaElementDelta.F_CHILDREN | IJavaElementDelta.F_PRIMARY_WORKING_COPY
            | IJavaElementDelta.F_AST_AFFECTED | IJavaElementDelta.F_FINE_GRAINED;
    /** Entries read from each library's Spring metadata, by project and archive. They depend
     * on the archive and the project's classpath only, so a source change rebuilds the index
     * without reading every dependency's metadata again: resolving its thousands of properties
     * to library members takes seconds. A changed archive stamp or classpath drops them. */
    private static final Map<String, Archive> ARCHIVES = new HashMap<>();
    private record Archive(FileStamp stamp, List<Entry> entries) {}
    static {
        JavaCore.addElementChangedListener(event -> {
            if (affects(event.getDelta())) REVISION.incrementAndGet();
            if (classpathChanged(event.getDelta())) synchronized (ARCHIVES) { ARCHIVES.clear(); }
        }, ElementChangedEvent.POST_CHANGE);
    }
    /** A project or package fragment root added, removed or reconfigured (not a change of
     * the sources or resources inside it). */
    static boolean classpathChanged(IJavaElementDelta delta) {
        if (delta.getElement().getElementType() > IJavaElement.PACKAGE_FRAGMENT_ROOT) return false;
        int flags = delta.getFlags() & ~(IGNORED_FLAGS | IJavaElementDelta.F_CONTENT);
        if (delta.getKind() != IJavaElementDelta.CHANGED || flags != 0) return true;
        for (IJavaElementDelta child : delta.getAffectedChildren()) if (classpathChanged(child)) return true;
        return false;
    }
    private static List<Entry> archive(String key, FileStamp stamp) {
        synchronized (ARCHIVES) {
            Archive known = ARCHIVES.get(key);
            return known != null && known.stamp.equals(stamp) ? known.entries : null;
        }
    }
    private static void remember(String key, FileStamp stamp, List<Entry> entries) {
        synchronized (ARCHIVES) {
            ARCHIVES.remove(key);
            if (ARCHIVES.values().stream().mapToInt(known -> known.entries.size()).sum() + entries.size() > MAX_ENTRIES)
                ARCHIVES.clear();
            if (entries.size() <= MAX_ENTRIES) ARCHIVES.put(key, new Archive(stamp, entries));
        }
    }
    static boolean affects(IJavaElementDelta delta) {
        int flags = delta.getFlags() & ~IGNORED_FLAGS;
        if (delta.getElement().getElementType() < IJavaElement.COMPILATION_UNIT) flags &= ~IJavaElementDelta.F_CONTENT;
        if (delta.getKind() != IJavaElementDelta.CHANGED || flags != 0) return true;
        for (IJavaElementDelta child : delta.getAffectedChildren()) if (affects(child)) return true;
        return false;
    }

    private record Entry(String name, String handle, Location location, boolean relaxed) {}
    private record FileStamp(java.nio.file.attribute.FileTime modified, long size) {}
    private static FileStamp stamp(Path path) {
        try { return new FileStamp(Files.getLastModifiedTime(path), Files.size(path)); }
        catch (java.io.IOException e) { return new FileStamp(null, -1); }
    }
    private record Index(long revision, String workingCopies, List<Entry> entries, List<String> roots,
            Map<Path, FileStamp> files, boolean incomplete, int parsed, long generation) {}

    @Override
    public Object executeCommand(String command, List<Object> args, IProgressMonitor monitor) throws Exception {
        if (command.equals("openidea.java.configuration.warmup")) return ConfigurationWarmup.request(args);
        String uri = (String) args.get(0);
        String key = args.get(1) instanceof String s ? s : null;
        int line = ((Number) args.get(2)).intValue(), column = ((Number) args.get(3)).intValue();
        boolean references = args.size() > 4 && Boolean.TRUE.equals(args.get(4));
        boolean declarations = args.size() > 5 && Boolean.TRUE.equals(args.get(5));
        ITypeRoot selectedRoot = JDTUtils.resolveTypeRoot(uri);
        IJavaProject project = selectedRoot == null ? project(uri) : selectedRoot.getJavaProject();
        if (project == null) return Map.of("locations", List.of(), "keys", List.of(), "roots", List.of(), "incomplete", true);
        Index index = index(project, monitor);
        Set<Map<String, Object>> keys = new LinkedHashSet<>();
        Set<Location> locations = new LinkedHashSet<>();
        String selected = null;
        if (key == null && selectedRoot != null && references) {
            var element = JDTUtils.findElementAtSelection(selectedRoot, line, column,
                    JavaLanguageServerPlugin.getPreferencesManager(), monitor);
            if (element != null) selected = element.getHandleIdentifier();
        }
        for (Entry entry : index.entries) {
            check(monitor);
            Location location = entry.location;
            if (key != null) {
                if (matches(entry.name, key, entry.relaxed)) {
                    if (!entry.handle.isEmpty() && references) {
                        var element = JavaCore.create(entry.handle);
                        if (element != null && element.exists()) {
                            List<Location> usages = new ArrayList<>();
                            new ReferencesHandler(JavaLanguageServerPlugin.getPreferencesManager())
                                .search(element, usages, monitor, declarations);
                            locations.addAll(usages);
                        }
                    } else {
                        if (location == null && !entry.handle.isEmpty()) location = location(entry.handle);
                        if (location != null) locations.add(location);
                    }
                    keys.add(Map.of("name", entry.name, "relaxed", entry.relaxed));
                }
            } else if ((!entry.handle.isEmpty() && entry.handle.equals(selected)) ||
                    (location != null && sameUri(location.getUri(), uri) && contains(location, line, column))) {
                keys.add(Map.of("name", entry.name, "relaxed", entry.relaxed));
            }
            if (locations.size() >= 2000) break;
        }
        // Reverse Find Usages joins property consumers with the binding member's
        // ordinary Java usages. Definition on a string only returns config keys.
        if (key == null && references && !keys.isEmpty()) {
            Set<String> searched = new HashSet<>();
            for (Entry entry : index.entries) {
                check(monitor);
                boolean related = keys.stream().anyMatch(pattern ->
                    matches(entry.name, (String) pattern.get("name"), entry.relaxed) ||
                    matches((String) pattern.get("name"), entry.name, Boolean.TRUE.equals(pattern.get("relaxed"))));
                if (!related) continue;
                if (entry.location != null) locations.add(entry.location);
                else if (!entry.handle.isEmpty() && searched.add(entry.handle)) {
                    IJavaElement element = JavaCore.create(entry.handle);
                    if (element != null && element.exists()) {
                        List<Location> usages = new ArrayList<>();
                        new ReferencesHandler(JavaLanguageServerPlugin.getPreferencesManager()).search(element, usages, monitor, declarations);
                        locations.addAll(usages);
                    }
                }
                if (locations.size() >= 2000) break;
            }
        }
        return Map.of("locations", locations, "keys", keys, "roots", index.roots,
                "incomplete", index.incomplete || locations.size() >= 2000,
                "parsedUnits", index.parsed, "revision", index.revision, "generation", index.generation);
    }

    private static boolean sameUri(String a, String b) {
        URI left = URI.create(a), right = URI.create(b);
        if (left.equals(right)) return true;
        if (!"file".equals(left.getScheme()) || !"file".equals(right.getScheme())) return false;
        try { return Path.of(left).toFile().getCanonicalFile().equals(Path.of(right).toFile().getCanonicalFile()); }
        catch (java.io.IOException e) { return false; }
    }
    private static boolean contains(Location l, int line, int col) {
        var r = l.getRange();
        return (line > r.getStart().getLine() || line == r.getStart().getLine() && col >= r.getStart().getCharacter()) &&
                (line < r.getEnd().getLine() || line == r.getEnd().getLine() && col < r.getEnd().getCharacter());
    }
    private static void check(IProgressMonitor monitor) { if (monitor.isCanceled()) throw new OperationCanceledException(); }
    static IJavaProject project(String uri) {
        Path path;
        try { path = Path.of(URI.create(uri)).toFile().getCanonicalFile().toPath(); } catch (Exception e) { return null; }
        IJavaProject best = null;
        int length = -1;
        for (var p : ResourcesPlugin.getWorkspace().getRoot().getProjects()) {
            if (!p.isOpen() || p.getLocation() == null) continue;
            var candidate = JavaCore.create(p);
            Path root;
            try { root = p.getLocation().toFile().getCanonicalFile().toPath(); } catch (java.io.IOException e) { continue; }
            if (candidate.exists() && path.startsWith(root) && root.getNameCount() > length) {
                best = candidate; length = root.getNameCount();
            }
        }
        return best;
    }
    private static Location location(String handle) throws JavaModelException {
        IJavaElement element = JavaCore.create(handle);
        if (element == null || !element.exists()) return null;
        Location result = JDTUtils.toLocation(element);
        if (result == null && element instanceof IMember member && member.getClassFile() != null)
            result = JDTUtils.toLocation(member.getClassFile());
        return result;
    }

    /** Builds (or reuses) the project's index in the background; its generation. */
    static long warm(IJavaProject project, IProgressMonitor monitor) throws Exception {
        return index(project, monitor, true).generation;
    }

    /** Warming fills free cache room only; it never evicts an index a lookup built. */
    static boolean hasWarmupCapacity(IJavaProject project) {
        synchronized (CACHE) {
            return CACHE.containsKey(project.getHandleIdentifier()) || (CACHE.size() < 8 &&
                    CACHE.values().stream().mapToInt(value -> value.entries.size()).sum() < MAX_ENTRIES);
        }
    }

    private static Index index(IJavaProject project, IProgressMonitor monitor) throws Exception {
        return index(project, monitor, false);
    }

    private static Index index(IJavaProject project, IProgressMonitor monitor, boolean background) throws Exception {
        ReentrantLock lock = LOCKS.computeIfAbsent(project.getHandleIdentifier(), ignored -> new ReentrantLock());
        while (!lock.tryLock(50, TimeUnit.MILLISECONDS)) check(monitor);
        try {
            check(monitor);
            return build(project, monitor, background);
        } finally { lock.unlock(); }
    }

    private static Index build(IJavaProject project, IProgressMonitor monitor, boolean background) throws Exception {
        long revision = REVISION.get();
        String id = project.getHandleIdentifier();
        Map<String, ICompilationUnit> copies = new TreeMap<>();
        for (ICompilationUnit copy : JavaCore.getWorkingCopies(null)) copies.put(copy.getPrimary().getHandleIdentifier(), copy);
        for (ICompilationUnit copy : JavaCore.getWorkingCopies(JavaLanguageServerPlugin.getInstance().getWorkingCopyOwner()))
            copies.put(copy.getPrimary().getHandleIdentifier(), copy);
        // Only unsaved contents differ from what the Java model reports for disk,
        // so merely opening or closing an editor keeps the snapshot.
        var digest = java.security.MessageDigest.getInstance("SHA-256");
        for (var entry : copies.entrySet()) {
            check(monitor);
            if (!entry.getValue().hasUnsavedChanges()) continue;
            digest.update(entry.getKey().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String source = entry.getValue().getSource();
            if (source != null) digest.update(source.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        String workingCopies = HexFormat.of().formatHex(digest.digest());
        Index cached;
        synchronized (CACHE) { cached = CACHE.get(id); }
        if (cached != null && cached.revision == revision && cached.workingCopies.equals(workingCopies)) {
            boolean valid = true;
            for (var entry : cached.files.entrySet()) {
                check(monitor);
                if (!entry.getValue().equals(stamp(entry.getKey()))) { valid = false; break; }
            }
            if (valid) return cached;
        }
        Builder builder = new Builder(monitor);
        Set<String> units = new HashSet<>(), roots = new LinkedHashSet<>();
        int visited = 0;
        for (IPackageFragmentRoot root : project.getAllPackageFragmentRoots()) {
            check(monitor);
            if (root.getKind() == IPackageFragmentRoot.K_SOURCE) {
                if (root.getResource() != null && root.getResource().getLocationURI() != null)
                    roots.add(root.getResource().getLocationURI().toString());
                if (root.getJavaProject().getProject().getLocationURI() != null)
                    roots.add(root.getJavaProject().getProject().getLocationURI().toString());
                if (root.getResource() != null && root.getResource().getLocation() != null)
                    builder.metadataDirectory(root.getResource().getLocation().toFile().toPath(), project);
                for (IJavaElement child : root.getChildren()) {
                    if (!(child instanceof IPackageFragment pkg)) continue;
                    for (ICompilationUnit unit : pkg.getCompilationUnits()) {
                        check(monitor);
                        unit = copies.getOrDefault(unit.getPrimary().getHandleIdentifier(), unit);
                        if (!units.add(unit.getHandleIdentifier())) continue;
                        if (++visited > MAX_UNITS || builder.entries.size() >= MAX_ENTRIES) { builder.incomplete = true; break; }
                        String source = unit.getSource();
                        if (source == null) continue;
                        if (source.length() > MAX_BYTES) { builder.incomplete = true; continue; }
                        // Cheap lexical filter only chooses candidates; all accepted symbols
                        // below are verified by JDT bindings, including constants and imports.
                        if (source.contains("ConfigurationProperties") || source.contains("Value") || source.contains("getProperty") || source.contains("getRequiredProperty"))
                            builder.parse(unit);
                    }
                }
            } else if (root.isArchive()) {
                builder.metadata(root, project);
            }
        }
        // Resource roots are not necessarily Java package roots (e.g. Maven resources).
        // Return project locations as well; the client excludes nested independent modules.
        roots.add(project.getProject().getLocationURI().toString());
        builder.metadataDirectory(project.getProject().getLocation().toFile().toPath().resolve("src/main/resources"), project);
        Index result = new Index(revision, workingCopies, List.copyOf(builder.entries), List.copyOf(roots), Map.copyOf(builder.files), builder.incomplete, builder.parsed, GENERATION.incrementAndGet());
        check(monitor);
        // A warmed index that the model has already outdated is dropped, not published.
        if (background && revision != REVISION.get()) throw new OperationCanceledException();
        synchronized (CACHE) {
            if (background && ((!CACHE.containsKey(id) && CACHE.size() >= 8) ||
                    CACHE.entrySet().stream().filter(e -> !e.getKey().equals(id)).mapToInt(e -> e.getValue().entries.size()).sum()
                            + result.entries.size() > MAX_ENTRIES)) throw new OperationCanceledException();
            CACHE.remove(id);
            while (!CACHE.isEmpty() && (CACHE.size() >= 8 ||
                    CACHE.values().stream().mapToInt(value -> value.entries.size()).sum() + result.entries.size() > MAX_ENTRIES))
                CACHE.remove(CACHE.keySet().iterator().next());
            CACHE.put(id, result);
        }
        return result;
    }

    /** Relaxed matching is reserved for binder/metadata entries. @Value and
     * Environment lookups retain their literal names; dots remain boundaries. */
    static boolean matches(String pattern, String key, boolean relaxed) {
        if (!relaxed) return pattern.equals(key);
        List<String> a = parts(pattern), b = parts(key);
        if (a.size() != b.size()) return false;
        for (int i = 0; i < a.size(); i++) if (!a.get(i).equals("*") && !a.get(i).equals(b.get(i))) return false;
        return true;
    }
    private static List<String> parts(String key) {
        List<String> result = new ArrayList<>();
        StringBuilder part = new StringBuilder();
        for (int i = 0; i < key.length(); i++) {
            char ch = key.charAt(i);
            if (ch == '[') {
                if (!part.isEmpty()) { result.add(canonical(part.toString())); part.setLength(0); }
                int end = key.indexOf(']', i + 1);
                if (end < 0) { part.append(key.substring(i)); break; }
                result.add(canonical(key.substring(i + 1, end))); i = end;
            } else if (ch == '.') {
                if (!part.isEmpty() || i == 0 || key.charAt(i - 1) != ']') result.add(canonical(part.toString()));
                part.setLength(0);
            } else part.append(ch);
        }
        if (!part.isEmpty()) result.add(canonical(part.toString()));
        return result;
    }
    private static String canonical(String key) {
        return key.replace("-", "").replace("_", "").toLowerCase(Locale.ROOT);
    }

    private static final class Builder {
        final IProgressMonitor monitor;
        final List<Entry> entries = new ArrayList<>();
        final Map<Path, FileStamp> files = new LinkedHashMap<>();
        boolean incomplete;
        int parsed;
        Builder(IProgressMonitor monitor) { this.monitor = monitor; }
        void add(String key, IJavaElement element) {
            if (key.length() > 1024 || entries.size() >= MAX_ENTRIES) { incomplete = true; return; }
            if (element != null) entries.add(new Entry(key, element.getHandleIdentifier(), null, true));
        }
        void use(String key, ICompilationUnit unit, ASTNode node) {
            if (key.length() > 1024 || entries.size() >= MAX_ENTRIES) { incomplete = true; return; }
            if (key.isBlank() || key.contains("${") || key.contains("#{")) return;
            try { entries.add(new Entry(key, "", JDTUtils.toLocation(unit, node.getStartPosition(), node.getLength()), false)); }
            catch (JavaModelException e) { incomplete = true; }
        }
        void parse(ICompilationUnit unit) {
            check(monitor);
            ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
            parser.setSource(unit);
            parser.setResolveBindings(true);
            parser.setWorkingCopyOwner(JavaLanguageServerPlugin.getInstance().getWorkingCopyOwner());
            parser.setBindingsRecovery(false);
            CompilationUnit tree = (CompilationUnit) parser.createAST(monitor);
            parsed++;
            tree.accept(new ASTVisitor() {
                @Override public void preVisit(ASTNode node) { check(monitor); }
                @Override public boolean visit(NormalAnnotation node) { annotation(node); return true; }
                @Override public boolean visit(SingleMemberAnnotation node) { annotation(node); return true; }
                @Override public boolean visit(MarkerAnnotation node) { annotation(node); return true; }
                private void annotation(Annotation node) {
                    IAnnotationBinding binding = node.resolveAnnotationBinding();
                    if (binding == null) return;
                    String name = binding.getAnnotationType().getQualifiedName();
                    if (name.equals(PROPERTIES)) {
                        String prefix = annotationValue(binding, "prefix");
                        if (prefix == null || prefix.isEmpty()) prefix = annotationValue(binding, "value");
                        if (prefix == null) prefix = "";
                        ASTNode owner = node.getParent();
                        if (owner instanceof AbstractTypeDeclaration type) {
                            bind(prefix, type.resolveBinding(), new HashSet<>(), 0);
                        } else if (owner instanceof MethodDeclaration method && method.resolveBinding() != null) {
                            add(prefix, method.resolveBinding().getJavaElement());
                            bind(prefix, method.resolveBinding().getReturnType(), new HashSet<>(), 0);
                        }
                    } else if (name.equals(VALUE)) {
                        String value = annotationValue(binding, "value");
                        ASTNode expression = node;
                        if (node instanceof SingleMemberAnnotation single) expression = single.getValue();
                        else if (node instanceof NormalAnnotation normal) {
                            for (Object pair : normal.values()) if (pair instanceof MemberValuePair p && p.getName().getIdentifier().equals("value")) expression = p.getValue();
                        }
                        if (value != null) placeholders(value, unit, expression);
                    }
                }
                @Override public boolean visit(MethodInvocation node) {
                    IMethodBinding method = node.resolveMethodBinding();
                    if (method != null && (method.getName().equals("getProperty") || method.getName().equals("getRequiredProperty")) &&
                            subtype(method.getDeclaringClass(), RESOLVER, new HashSet<>()) && !node.arguments().isEmpty()) {
                        Expression arg = (Expression) node.arguments().get(0);
                        Object constant = arg.resolveConstantExpressionValue();
                        if (constant instanceof String key) use(key, unit, arg);
                    }
                    return true;
                }
            });
        }
        void placeholders(String text, ICompilationUnit unit, ASTNode node) {
            // Include nested default placeholders, but never a dynamically composed name.
            for (int at = text.indexOf("${"); at >= 0; at = text.indexOf("${", at + 2)) {
                int end = at + 2;
                while (end < text.length() && text.charAt(end) != ':' && text.charAt(end) != '}') end++;
                if (end < text.length()) use(text.substring(at + 2, end), unit, node);
            }
        }
        void bind(String prefix, ITypeBinding type, Set<String> visiting, int depth) {
            check(monitor);
            if (type == null || type.isRecovered() || type.isPrimitive() || type.isEnum()) return;
            String qualified = type.getErasure().getQualifiedName();
            if (qualified.startsWith("java.") || qualified.startsWith("javax.")) return;
            if (depth > 12 || !visiting.add(type.getKey())) return;
            try {
                if (!prefix.isEmpty()) add(prefix, type.getJavaElement());
                List<IMethodBinding> constructors = Arrays.stream(type.getDeclaredMethods())
                    .filter(m -> m.isConstructor() && !Modifier.isPrivate(m.getModifiers())).toList();
                for (IMethodBinding constructor : constructors) {
                    boolean explicit = Arrays.stream(constructor.getAnnotations()).anyMatch(a ->
                        a.getAnnotationType().getQualifiedName().equals("org.springframework.boot.context.properties.bind.ConstructorBinding") ||
                        a.getAnnotationType().getQualifiedName().equals("org.springframework.boot.context.properties.ConstructorBinding"));
                    if (!explicit && constructors.size() != 1) continue;
                    String[] parameters = constructor.getParameterNames();
                    for (int i = 0; i < parameters.length; i++) {
                        String name = parameters[i];
                        for (IAnnotationBinding annotation : constructor.getParameterAnnotations(i)) {
                            if (annotation.getAnnotationType().getQualifiedName().equals("org.springframework.boot.context.properties.bind.Name")) {
                                String alias = annotationValue(annotation, "value");
                                if (alias != null) name = alias;
                            }
                        }
                        // Prefer fields/accessors for ordinary parameters; aliases and
                        // constructor-only properties still have a navigable declaration.
                        final String parameterName = name;
                        if (Arrays.stream(type.getDeclaredFields()).noneMatch(f -> f.getName().equals(parameterName))) {
                            add(join(prefix, name), constructor.getJavaElement());
                            nested(join(prefix, name), constructor.getParameterTypes()[i], constructor.getJavaElement(), visiting, depth + 1);
                        }
                    }
                }
                Set<String> names = new HashSet<>();
                for (ITypeBinding current = type; current != null && !current.getQualifiedName().equals("java.lang.Object"); current = current.getSuperclass()) {
                    for (IVariableBinding field : current.getDeclaredFields()) {
                        if (Modifier.isStatic(field.getModifiers()) || field.isSynthetic() || !names.add(field.getName())) continue;
                        String key = join(prefix, field.getName());
                        add(key, field.getJavaElement());
                        nested(key, field.getType(), field.getJavaElement(), visiting, depth + 1);
                    }
                    for (IMethodBinding method : current.getDeclaredMethods()) {
                        if (Modifier.isStatic(method.getModifiers()) || method.isConstructor()) continue;
                        String name = method.getName();
                        String property = null;
                        ITypeBinding propertyType = null;
                        if (name.startsWith("set") && name.length() > 3 && method.getParameterTypes().length == 1) {
                            property = name.substring(3); propertyType = method.getParameterTypes()[0];
                        } else if (name.startsWith("get") && name.length() > 3 && method.getParameterTypes().length == 0) {
                            property = name.substring(3); propertyType = method.getReturnType();
                        }
                        if (property != null) {
                            property = Character.toLowerCase(property.charAt(0)) + property.substring(1);
                            String key = join(prefix, property);
                            add(key, method.getJavaElement());
                            if (names.add(property)) nested(key, propertyType, method.getJavaElement(), visiting, depth + 1);
                        }
                    }
                }
            } finally { visiting.remove(type.getKey()); }
        }
        void nested(String key, ITypeBinding type, IJavaElement owner, Set<String> visiting, int depth) {
            if (type == null) return;
            if (type.isArray()) { add(key + "[*]", owner); bind(key + "[*]", type.getElementType(), visiting, depth); return; }
            String raw = type.getErasure().getQualifiedName();
            if (subtype(type, "java.util.Map", new HashSet<>())) {
                add(key + ".*", owner);
                var args = type.getTypeArguments();
                if (args.length == 2) bind(key + ".*", args[1], visiting, depth);
            } else if (subtype(type, "java.util.Collection", new HashSet<>())) {
                add(key + "[*]", owner);
                var args = type.getTypeArguments();
                if (args.length == 1) bind(key + "[*]", args[0], visiting, depth);
            } else if (!type.isPrimitive() && !type.isEnum() && !raw.startsWith("java.") && !raw.startsWith("javax.")) {
                bind(key, type, visiting, depth);
            }
        }
        void metadata(IPackageFragmentRoot root, IJavaProject project) {
            check(monitor);
            Path path = root.getPath().toFile().toPath();
            if (!root.isExternal() && root.getResource() != null && root.getResource().getLocation() != null)
                path = root.getResource().getLocation().toFile().toPath();
            FileStamp stamp = stamp(path);
            files.put(path, stamp);
            if (!Files.isRegularFile(path)) return;
            String key = project.getHandleIdentifier() + '\n' + path;
            List<Entry> known = archive(key, stamp);
            if (known != null && entries.size() + known.size() <= MAX_ENTRIES) {
                entries.addAll(known);
                return;
            }
            int start = entries.size();
            boolean before = incomplete;
            incomplete = false;
            try (ZipFile zip = new ZipFile(path.toFile())) {
                for (String filename : List.of("spring-configuration-metadata.json", "additional-spring-configuration-metadata.json")) {
                    var entry = zip.getEntry("META-INF/" + filename);
                    if (entry == null) continue;
                    if (entry.getSize() > MAX_BYTES) { incomplete = true; continue; }
                    JsonObject metadata;
                    try (var stream = zip.getInputStream(entry)) {
                        byte[] bytes = stream.readNBytes(MAX_BYTES + 1);
                        if (bytes.length > MAX_BYTES) { incomplete = true; continue; }
                        metadata = JsonParser.parseString(new String(bytes, java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject();
                    }
                    metadataObject(metadata, project);
                }
            } catch (Exception e) { if (e instanceof OperationCanceledException) throw (OperationCanceledException)e; incomplete = true; }
            // Only a complete reading is reused; an incomplete one is read again next time.
            if (!incomplete) remember(key, stamp, List.copyOf(entries.subList(start, entries.size())));
            incomplete |= before;
        }
        void metadataObject(JsonObject metadata, IJavaProject project) throws JavaModelException {
            JsonArray groups = metadata.has("groups") ? metadata.getAsJsonArray("groups") : new JsonArray();
            for (JsonElement value : groups) {
                check(monitor);
                JsonObject group = value.getAsJsonObject();
                String name = string(group, "name"), source = string(group, "sourceType");
                if (source == null) source = string(group, "type");
                if (name != null && source != null) add(name, project.findType(source.replace('$', '.'), monitor));
            }
            if (!metadata.has("properties")) return;
            for (JsonElement value : metadata.getAsJsonArray("properties")) {
                check(monitor);
                if (entries.size() >= MAX_ENTRIES) { incomplete = true; return; }
                JsonObject property = value.getAsJsonObject();
                String key = string(property, "name"), source = string(property, "sourceType"), prefix = "";
                if (key == null) continue;
                JsonObject owner = null;
                for (JsonElement groupValue : groups) {
                    JsonObject group = groupValue.getAsJsonObject();
                    String name = string(group, "name");
                    if (name != null && key.startsWith(name + ".") && name.length() > prefix.length()) {
                        prefix = name; owner = group;
                    }
                }
                if (source == null && owner != null) source = string(owner, "type");
                if (source == null && owner != null) source = string(owner, "sourceType");
                if (source == null) continue;
                IType type = project.findType(source.replace('$', '.'), monitor);
                if (type == null) continue;
                String leaf = key.substring(prefix.isEmpty() ? 0 : prefix.length() + 1);
                IJavaElement target = member(type, leaf, new HashSet<>());
                if (target == null && owner != null && string(owner, "sourceMethod") != null) {
                    String declaring = string(owner, "sourceType");
                    IType factory = declaring == null ? null : project.findType(declaring.replace('$', '.'), monitor);
                    if (factory != null) {
                        String methodName = string(owner, "sourceMethod").split("\\(", 2)[0];
                        for (IMethod method : factory.getMethods()) if (method.getElementName().equals(methodName)) { target = method; break; }
                    }
                }
                add(key, target == null ? type : target);
            }
        }
        void metadataDirectory(Path directory, IJavaProject project) {
            for (String name : List.of("spring-configuration-metadata.json", "additional-spring-configuration-metadata.json")) {
                Path file = directory.resolve("META-INF").resolve(name);
                files.put(file, stamp(file));
                if (!Files.isRegularFile(file)) continue;
                try {
                    if (Files.size(file) > MAX_BYTES) { incomplete = true; continue; }
                    try (var stream = Files.newInputStream(file)) {
                        byte[] bytes = stream.readNBytes(MAX_BYTES + 1);
                        if (bytes.length > MAX_BYTES) { incomplete = true; continue; }
                        metadataObject(JsonParser.parseString(new String(bytes, java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject(), project);
                    }
                } catch (Exception e) { if (e instanceof OperationCanceledException) throw (OperationCanceledException)e; incomplete = true; }
            }
        }
    }
    private static IJavaElement member(IType type, String key, Set<String> seen) throws JavaModelException {
        if (type == null || !seen.add(type.getHandleIdentifier())) return null;
        String part = key.split("\\.", 2)[0];
        for (IField field : type.getFields()) if (canonical(field.getElementName()).equals(canonical(part))) {
            if (!key.contains(".")) return field;
            String signature = Signature.toString(Signature.getTypeErasure(field.getTypeSignature()));
            String[][] resolved = type.resolveType(signature);
            IType nested = type.getJavaProject().findType(signature);
            if (nested == null && resolved != null && resolved.length == 1)
                nested = type.getJavaProject().findType(resolved[0][0] + "." + resolved[0][1]);
            IJavaElement found = member(nested, key.substring(key.indexOf('.') + 1), seen);
            return found == null ? field : found;
        }
        for (IMethod method : type.getMethods()) {
            String name = method.getElementName();
            if (name.length() > 3 && (name.startsWith("get") || name.startsWith("set")) && canonical(name.substring(3)).equals(canonical(part))) return method;
        }
        String parent = type.getSuperclassName();
        if (parent != null) {
            String[][] resolved = type.resolveType(parent);
            if (resolved != null && resolved.length == 1)
                return member(type.getJavaProject().findType(resolved[0][0] + "." + resolved[0][1]), key, seen);
        }
        return null;
    }
    private static String string(JsonObject object, String key) {
        return object.has(key) && object.get(key).isJsonPrimitive() ? object.get(key).getAsString() : null;
    }
    private static String annotationValue(IAnnotationBinding binding, String name) {
        for (IMemberValuePairBinding pair : binding.getAllMemberValuePairs())
            if (pair.getName().equals(name) && pair.getValue() instanceof String s) return s;
        return null;
    }
    private static String join(String prefix, String name) { return prefix.isEmpty() ? name : prefix + "." + name; }
    private static boolean subtype(ITypeBinding type, String name, Set<String> seen) {
        if (type == null || !seen.add(type.getKey())) return false;
        if (type.getErasure().getQualifiedName().equals(name)) return true;
        for (ITypeBinding face : type.getInterfaces()) if (subtype(face, name, seen)) return true;
        return subtype(type.getSuperclass(), name, seen);
    }
}
