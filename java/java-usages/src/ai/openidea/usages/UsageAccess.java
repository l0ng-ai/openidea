package ai.openidea.usages;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.core.dom.*;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.lsp4j.Location;

/** Structural access context for already semantically bound search results.
 * One syntax parse per source file per query; no second reference search.
 */
final class UsageAccess {
    private record Parsed(ICompilationUnit unit, String source, CompilationUnit tree, Map<Long, ASTNode> exactNodes) {}
    private final Map<String, Parsed> files = new HashMap<>();
    private final IProgressMonitor monitor;
    private final Map<String, List<Location>> requests = new HashMap<>();
    UsageAccess(IProgressMonitor monitor, Map<Location, String> results) {
        this.monitor = monitor;
        results.forEach((location, kind) -> {
            if (!kind.equals("unknown")) requests.computeIfAbsent(location.getUri(), k -> new ArrayList<>()).add(location);
        });
    }

    private static long rangeKey(int start, int length) { return ((long) start << 32) | (length & 0xffffffffL); }

    private Map<Long, ASTNode> index(CompilationUnit tree, String uri) {
        List<Location> locations = requests.get(uri);
        // A few lookups do not justify traversing an entire file. Index exact AST
        // and selector-to-call-end ranges; all other ranges retain NodeFinder.
        if (locations == null || locations.size() < 16) return Map.of();
        var wanted = new HashSet<Long>();
        for (Location location : locations) {
            var range = location.getRange();
            int start = tree.getPosition(range.getStart().getLine() + 1, range.getStart().getCharacter());
            int end = tree.getPosition(range.getEnd().getLine() + 1, range.getEnd().getCharacter());
            if (start >= 0 && end > start) wanted.add(rangeKey(start, end - start));
        }
        Map<Long, ASTNode> nodes = new HashMap<>();
        tree.accept(new ASTVisitor(true) {
            int visited;
            @Override public void preVisit(ASTNode node) {
                if ((visited++ & 127) == 0 && monitor.isCanceled()) throw new OperationCanceledException();
                int start = node.getStartPosition();
                long end = (long) start + node.getLength();
                add(rangeKey(start, node.getLength()), node);
                // JDT method matches may start at the selector (after receiver)
                // and end after the arguments. That span is covered by this call,
                // but not by any of its children. It is not a method reference.
                SimpleName name = node instanceof MethodInvocation call ? call.getName() :
                    node instanceof SuperMethodInvocation call ? call.getName() : null;
                if (name != null && end <= Integer.MAX_VALUE && name.getLength() > 0 &&
                    (name.getFlags() & (ASTNode.MALFORMED | ASTNode.RECOVERED)) == 0 &&
                    name.getStartPosition() >= start && end > (long) name.getStartPosition() + name.getLength())
                    add(rangeKey(name.getStartPosition(), (int) (end - name.getStartPosition())), node);
            }
            private void add(long key, ASTNode node) {
                if (!wanted.contains(key)) return;
                if (nodes.containsKey(key)) {
                    if (nodes.get(key) != node) nodes.put(key, null);
                    return;
                }
                boolean contained = true;
                for (ASTNode parent = node; parent != null; parent = parent.getParent()) {
                    if ((parent.getFlags() & (ASTNode.MALFORMED | ASTNode.RECOVERED)) != 0 ||
                        parent.getStartPosition() > node.getStartPosition() ||
                        (long) parent.getStartPosition() + parent.getLength() < (long) node.getStartPosition() + node.getLength()) {
                        contained = false;
                        break;
                    }
                }
                nodes.put(key, contained ? node : null);
            }
        });
        return nodes;
    }

    String classify(Location location, String kind) {
        if (kind.equals("unknown")) return "unknown";
        if (monitor.isCanceled()) throw new OperationCanceledException();
        try {
            String uri = location.getUri();
            if (!files.containsKey(uri)) {
                Parsed parsed = null;
                ITypeRoot root = JDTUtils.resolveTypeRoot(uri);
                if (root instanceof ICompilationUnit unit && unit.getResource() != null) {
                    String source = unit.getBuffer().getContents();
                    ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
                    parser.setSource(source.toCharArray());
                    parser.setCompilerOptions(unit.getJavaProject().getOptions(true));
                    // SearchEngine has already resolved the target identity. Here only
                    // expression structure is needed; do not resolve the project again.
                    CompilationUnit tree = (CompilationUnit) parser.createAST(monitor);
                    parsed = new Parsed(unit, source, tree, index(tree, uri));
                }
                files.put(uri, parsed);
            }
            Parsed file = files.get(uri);
            if (file == null || !file.source.equals(file.unit.getBuffer().getContents())) return "unknown";
            var range = location.getRange();
            int start = file.tree.getPosition(range.getStart().getLine() + 1, range.getStart().getCharacter());
            int end = file.tree.getPosition(range.getEnd().getLine() + 1, range.getEnd().getCharacter());
            if (start < 0 || end < start) return "unknown";
            ASTNode node = file.exactNodes.get(rangeKey(start, end - start));
            if (node == null) node = NodeFinder.perform(file.tree, start, end - start);
            if (node == null || (node.getFlags() & (ASTNode.MALFORMED | ASTNode.RECOVERED)) != 0) return "unknown";
            if (kind.equals("getter") || kind.equals("setter")) {
                for (ASTNode p = node; p != null; p = p.getParent()) {
                    if (p instanceof MethodReference) return "unknown";
                    if (p instanceof MethodInvocation || p instanceof SuperMethodInvocation)
                        return kind.equals("getter") ? "read" : "write";
                    if (p instanceof Statement || p instanceof BodyDeclaration) break;
                }
                return "unknown";
            }
            if (!(node instanceof SimpleName name) || name.isDeclaration()) return "unknown";
            ASTNode expression = node;
            while (true) {
                ASTNode parent = expression.getParent();
                if (parent instanceof QualifiedName q && q.getName() == expression ||
                    parent instanceof FieldAccess f && f.getName() == expression ||
                    parent instanceof SuperFieldAccess f && f.getName() == expression ||
                    parent instanceof ParenthesizedExpression p && p.getExpression() == expression) {
                    expression = parent;
                } else break;
            }
            ASTNode parent = expression.getParent();
            if (parent instanceof Assignment a && a.getLeftHandSide() == expression)
                return a.getOperator() == Assignment.Operator.ASSIGN ? "write" : "readWrite";
            if (parent instanceof PostfixExpression) return "readWrite";
            if (parent instanceof PrefixExpression p && (p.getOperator() == PrefixExpression.Operator.INCREMENT ||
                    p.getOperator() == PrefixExpression.Operator.DECREMENT)) return "readWrite";
            return "read";
        } catch (OperationCanceledException e) {
            throw e;
        } catch (Exception e) {
            // A missing/changed/unparseable document must remain visible, never guessed.
            return "unknown";
        }
    }
}
