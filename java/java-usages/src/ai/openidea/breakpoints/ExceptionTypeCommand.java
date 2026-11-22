package ai.openidea.breakpoints;

import ai.openidea.Documents;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.ITypeRoot;
import org.eclipse.jdt.core.dom.*;
import org.eclipse.jdt.core.manipulation.CoreASTProvider;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.handlers.JsonRpcHelpers;

/**
 * The exception class a caret names, for the Create / Enable / Disable exception breakpoint intention.
 *
 * <p>{@code openidea.java.exceptionType(uri, line, column)} answers {@code {qualifiedName, displayName}}
 * ({@code qualifiedName} is the binary name, {@code app.Outer$Failure}) or {@code null}. It follows
 * IntelliJ's {@code ControlExceptionBreakpointJVMSupport}: from the token right of the caret, else the
 * one left of it, the nearest enclosing reference, class or throw statement decides. A reference gives
 * the class it resolves to (a constructor's class; a variable, a method or a package gives nothing), a
 * class gives itself only on its name, and a throw statement the class of the thrown expression. The
 * class must be a {@link Throwable} with a qualified name: not unresolved, local, anonymous or a type
 * variable.
 */
public final class ExceptionTypeCommand implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        Documents.awaitChanges(monitor);
        String uri = (String) arguments.get(0);
        int line = ((Number) arguments.get(1)).intValue();
        int column = ((Number) arguments.get(2)).intValue();
        ITypeRoot root = JDTUtils.resolveTypeRoot(uri);
        if (root == null || !root.exists()) return null;
        CompilationUnit ast = CoreASTProvider.getInstance().getAST(root, CoreASTProvider.WAIT_YES, monitor);
        if (ast == null) return null;
        int offset = JsonRpcHelpers.toOffset(root, line, column);
        if (offset < 0) return null;
        ITypeBinding found = classAt(ast, offset);
        if (found == null && offset > 0) found = classAt(ast, offset - 1);
        return found == null ? null : describe(found);
    }

    /** The exception class for the token holding the character at {@code offset}. */
    static ITypeBinding classAt(CompilationUnit ast, int offset) {
        if (offset >= ast.getStartPosition() + ast.getLength()) return null;
        ASTNode leaf = new NodeFinder(ast, offset, 1).getCoveringNode();
        ITypeBinding type = classReference(leaf);
        return isException(type) ? type : null;
    }

    private static ITypeBinding classReference(ASTNode leaf) {
        for (ASTNode n = leaf; n != null; n = n.getParent()) {
            if (n instanceof AbstractTypeDeclaration declaration) {
                return leaf == declaration.getName() ? declaration.resolveBinding() : null;
            }
            if (n instanceof AnonymousClassDeclaration) return null;
            if (n instanceof ThrowStatement thrown) return thrown.getExpression().resolveTypeBinding();
            if (isReference(n)) return referencedClass(n);
        }
        return null;
    }

    /**
     * What UAST converts to a reference expression: a name that is not a declaration or a label, a
     * field access, a call or instance creation with a qualifier, a method or constructor reference.
     */
    private static boolean isReference(ASTNode n) {
        if (n instanceof SimpleName name) {
            if (name.isDeclaration()) return false;
            StructuralPropertyDescriptor at = name.getLocationInParent();
            return at != LabeledStatement.LABEL_PROPERTY && at != BreakStatement.LABEL_PROPERTY
                    && at != ContinueStatement.LABEL_PROPERTY && at != MemberValuePair.NAME_PROPERTY;
        }
        return n instanceof QualifiedName || n instanceof FieldAccess || n instanceof SuperFieldAccess
                || n instanceof SuperMethodInvocation || n instanceof MethodReference || n instanceof MemberRef
                || n instanceof MethodRef || (n instanceof MethodInvocation call && call.getExpression() != null)
                || (n instanceof ClassInstanceCreation creation && creation.getExpression() != null);
    }

    private static ITypeBinding referencedClass(ASTNode reference) {
        IBinding binding = switch (reference) {
            case Name name -> name.resolveBinding();
            case ClassInstanceCreation creation -> creation.resolveConstructorBinding();
            case MethodReference method -> method.resolveMethodBinding();
            case MethodInvocation call -> call.resolveMethodBinding();
            case SuperMethodInvocation call -> call.resolveMethodBinding();
            default -> null;
        };
        if (binding instanceof ITypeBinding type) return type;
        if (binding instanceof IMethodBinding method && method.isConstructor()) return method.getDeclaringClass();
        return null;
    }

    private static boolean isException(ITypeBinding type) {
        if (type == null || type.isRecovered() || !type.isClass() || type.isLocal() || type.isAnonymous()) return false;
        for (ITypeBinding t = type.getErasure(); t != null; t = t.getSuperclass()) {
            if ("java.lang.Throwable".equals(t.getQualifiedName())) return true;
        }
        return false;
    }

    private static Map<String, String> describe(ITypeBinding type) {
        ITypeBinding erased = type.getErasure();
        String binary = erased.getBinaryName();
        if (binary == null) return null;
        Map<String, String> out = new LinkedHashMap<>();
        out.put("qualifiedName", binary);
        out.put("displayName", erased.getName());
        return out;
    }
}
