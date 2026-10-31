package ai.openidea.usages;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.internal.corext.codemanipulation.GetterSetterUtil;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.handlers.ReferencesHandler;
import org.eclipse.lsp4j.*;

/** Classifies search results using JDT method identities, never reference text. */
public final class UsagesCommand implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        String uri = (String) arguments.get(0);
        int line = ((Number) arguments.get(1)).intValue();
        int column = ((Number) arguments.get(2)).intValue();
        boolean declarations = Boolean.TRUE.equals(arguments.get(3));
        var preferences = JavaLanguageServerPlugin.getPreferencesManager();
        var handler = new ReferencesHandler(preferences);
        var params = new ReferenceParams(new TextDocumentIdentifier(uri), new Position(line, column), new ReferenceContext(declarations));
        Map<Location, String> results = new LinkedHashMap<>();
        ITypeRoot root = JDTUtils.resolveTypeRoot(uri);
        IJavaElement selected = root == null ? null :
                JDTUtils.findElementAtSelection(root, line, column, preferences, monitor);
        if (monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
        boolean accessors = preferences.getPreferences().isIncludeAccessors();
        SearchPlan plan = new SearchPlan();
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
        } else {
            // Includes non-fields, library/decompiled roots, and unverified JDT LS builds.
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
            add(handler, target.element, target.kind(), target.declarations, results, monitor);
        }
        if (monitor.isCanceled()) throw new org.eclipse.core.runtime.OperationCanceledException();
        List<Map<String, Object>> response = new ArrayList<>();
        UsageAccess access = new UsageAccess(monitor, results);
        results.forEach((location, kind) -> response.add(Map.of("location", location, "kind", kind, "access", access.classify(location, kind))));
        return response;
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

    private static void add(ReferencesHandler handler, IJavaElement element, String kind, boolean declarations,
            Map<Location, String> results, IProgressMonitor monitor) throws Exception {
        if (element == null) return;
        List<Location> locations = new ArrayList<>();
        handler.search(element, locations, monitor, declarations);
        for (var location : locations) {
            if (kind.equals("unknown")) { results.putIfAbsent(location, kind); continue; }
            String previous = results.get(location);
            results.put(location, previous == null || previous.equals("unknown") || previous.equals(kind) ? kind : "unknown");
        }
    }
}
