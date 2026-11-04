package ai.openidea.hierarchy;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.core.*;
import org.eclipse.jdt.internal.core.manipulation.JavaElementLabelsCore;
import org.eclipse.jdt.internal.corext.refactoring.RefactoringAvailabilityTesterCore;
import org.eclipse.jdt.internal.corext.refactoring.structure.PullUpRefactoringProcessor;
import org.eclipse.jdt.internal.corext.refactoring.structure.PushDownRefactoringProcessor;
import org.eclipse.jdt.internal.corext.refactoring.structure.PushDownRefactoringProcessor.MemberActionInfo;
import org.eclipse.jdt.internal.corext.util.JdtFlags;
import org.eclipse.jdt.ls.core.internal.ChangeUtil;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.handlers.JsonRpcHelpers;
import org.eclipse.jdt.ls.core.internal.preferences.PreferenceManager;
import org.eclipse.ltk.core.refactoring.Change;
import org.eclipse.ltk.core.refactoring.RefactoringStatus;
import org.eclipse.ltk.core.refactoring.RefactoringStatusEntry;
import org.eclipse.ltk.core.refactoring.participants.ProcessorBasedRefactoring;
import org.eclipse.ltk.core.refactoring.participants.RefactoringProcessor;

/**
 * Pull Members Up / Push Members Down with JDT's own processors.
 *
 * <p>{@code openidea.java.hierarchy.members(uri, line, column, kind)} describes the class at the
 * position: its movable members and, for pull up, the supertypes in project sources.
 * {@code openidea.java.hierarchy.refactor(uri, line, column, kind, target, choices)} checks the
 * chosen move and returns its problems and the edit, which is never applied here. {@code kind}
 * is {@code pullUp} or {@code pushDown}; {@code choices} are {@code {id, abstract}} objects whose
 * ids are the handle identifiers returned by {@code members}.
 */
public final class HierarchyCommand implements IDelegateCommandHandler {
    static final String MEMBERS = "openidea.java.hierarchy.members";
    static final String REFACTOR = "openidea.java.hierarchy.refactor";

    private static final long LABEL = JavaElementLabelsCore.M_PARAMETER_TYPES | JavaElementLabelsCore.M_APP_RETURNTYPE
            | JavaElementLabelsCore.F_APP_TYPE_SIGNATURE;

    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        String uri = (String) arguments.get(0);
        int line = ((Number) arguments.get(1)).intValue();
        int column = ((Number) arguments.get(2)).intValue();
        boolean pullUp = switch ((String) arguments.get(3)) {
            case "pullUp" -> true;
            case "pushDown" -> false;
            default -> throw new IllegalArgumentException("unknown hierarchy refactoring " + arguments.get(3));
        };
        ICompilationUnit unit = JDTUtils.resolveCompilationUnit(uri);
        if (unit == null || !unit.exists()) return refused("The file is not part of a Java project");
        IMember start = memberAt(unit, JsonRpcHelpers.toOffset(unit, line, column));
        IMember[] members = start == null ? null : selection(start, pullUp);
        if (members == null) {
            return refused(pullUp ? "Caret should be inside a class that has members to pull up"
                    : "Caret should be inside a class that has members to push down");
        }
        if (MEMBERS.equals(command)) return pullUp ? pullUpMembers(unit, members, monitor) : pushDownMembers(members, monitor);
        if (REFACTOR.equals(command)) {
            String target = (String) arguments.get(4);
            List<Choice> choices = new ArrayList<>();
            for (Object o : (List<?>) arguments.get(5)) {
                Map<?, ?> map = (Map<?, ?>) o;
                IJavaElement element = JavaCore.create((String) map.get("id"));
                if (!(element instanceof IMember member) || !member.exists()) return refused("The class changed; open the dialog again");
                choices.add(new Choice(member, Boolean.TRUE.equals(map.get("abstract"))));
            }
            if (choices.isEmpty()) return refused("No members selected");
            // Started from the class, the processors know it even when no member is moved
            // (a method only declared abstract in the destination).
            IType declaring = members[0] instanceof IType type ? type : members[0].getDeclaringType();
            IMember[] owner = { declaring };
            return pullUp ? pullUp(unit, owner, target, choices, monitor) : pushDown(owner, choices, monitor);
        }
        throw new IllegalArgumentException("unknown command " + command);
    }

    private record Choice(IMember member, boolean makeAbstract) {}

    /** The innermost member at the offset, or the type itself for an initializer. */
    private static IMember memberAt(ICompilationUnit unit, int offset) throws JavaModelException {
        IJavaElement element = unit.getElementAt(offset);
        while (element != null && !(element instanceof IMember)) element = element.getParent();
        if (element instanceof IInitializer initializer) return initializer.getDeclaringType();
        return (IMember) element;
    }

    /** The members to start from: the one at the caret when it can move, otherwise its class. */
    private static IMember[] selection(IMember start, boolean pullUp) throws JavaModelException {
        for (IMember member = start; member != null; member = member.getDeclaringType()) {
            if (member.isBinary() || member.isReadOnly()) return null;
            if (pullUp ? RefactoringAvailabilityTesterCore.isPullUpAvailable(member)
                    : RefactoringAvailabilityTesterCore.isPushDownAvailable(member)) return new IMember[] { member };
            if (member instanceof IType type && (pullUp ? RefactoringAvailabilityTesterCore.getPullUpMembers(type)
                    : RefactoringAvailabilityTesterCore.getPushDownMembers(type)).length > 0) {
                return new IMember[] { type };
            }
        }
        return null;
    }

    private static Object pullUpMembers(ICompilationUnit unit, IMember[] members, IProgressMonitor monitor) throws Exception {
        var processor = new PullUpRefactoringProcessor(members, PreferenceManager.getCodeGenerationSettings(unit));
        RefactoringStatus status = new ProcessorBasedRefactoring(processor).checkInitialConditions(monitor);
        if (status.hasFatalError()) return refused(status.getMessageMatchingSeverity(RefactoringStatus.FATAL));
        IType[] candidates = processor.getCandidateTypes(new RefactoringStatus(), monitor);
        cancelled(monitor);
        if (candidates.length == 0) {
            return refused("'" + processor.getDeclaringType().getElementName()
                    + "' has no superclass or interface in the project sources to pull members up to");
        }
        List<Map<String, Object>> targets = new ArrayList<>();
        for (IType type : candidates) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", type.getHandleIdentifier());
            row.put("name", type.getElementName());
            row.put("qualifiedName", type.getFullyQualifiedName('.'));
            row.put("interface", type.isInterface());
            targets.add(row);
        }
        Set<IMember> selected = Set.of(processor.getMembersToMove());
        List<Map<String, Object>> rows = new ArrayList<>();
        for (IMember member : processor.getPullableMembersOfDeclaringType()) {
            boolean abstractable = member instanceof IMethod method && !JdtFlags.isStatic(method);
            rows.add(member(member, selected.contains(member), abstractable));
        }
        return info(processor.getDeclaringType(), targets, rows);
    }

    private static Object pushDownMembers(IMember[] members, IProgressMonitor monitor) throws Exception {
        var processor = new PushDownRefactoringProcessor(members);
        RefactoringStatus status = new ProcessorBasedRefactoring(processor).checkInitialConditions(monitor);
        if (status.hasFatalError()) return refused(status.getMessageMatchingSeverity(RefactoringStatus.FATAL));
        IType declaring = processor.getDeclaringType();
        List<Map<String, Object>> targets = new ArrayList<>();
        for (IType type : declaring.newTypeHierarchy(declaring.getJavaProject(), monitor).getSubtypes(declaring)) {
            if (type.isBinary()) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", type.getHandleIdentifier());
            row.put("name", type.getElementName());
            row.put("qualifiedName", type.getFullyQualifiedName('.'));
            row.put("interface", type.isInterface());
            targets.add(row);
        }
        cancelled(monitor);
        List<Map<String, Object>> rows = new ArrayList<>();
        for (MemberActionInfo info : processor.getMemberActionInfos()) {
            boolean abstractable = false;
            for (int action : info.getAvailableActions()) abstractable |= action == MemberActionInfo.PUSH_ABSTRACT_ACTION;
            rows.add(member(info.getMember(), info.isToBePushedDown(), abstractable));
        }
        return info(declaring, targets, rows);
    }

    private static Object pullUp(ICompilationUnit unit, IMember[] members, String target, List<Choice> choices,
            IProgressMonitor monitor) throws Exception {
        if (!(JavaCore.create(target) instanceof IType destination) || !destination.exists()) {
            return refused("The destination class no longer exists");
        }
        var processor = new PullUpRefactoringProcessor(members, PreferenceManager.getCodeGenerationSettings(unit));
        List<IMember> moved = new ArrayList<>();
        List<IMethod> declaredAbstract = new ArrayList<>();
        List<IMethod> deleted = new ArrayList<>();
        for (Choice choice : choices) {
            // A method pulled up to an interface is declared there, as JDT's own wizard does.
            if (choice.member instanceof IMethod method && (choice.makeAbstract || destination.isInterface())) {
                declaredAbstract.add(method);
            } else {
                moved.add(choice.member);
                if (choice.member instanceof IMethod method) deleted.add(method);
            }
        }
        processor.setMembersToMove(moved.toArray(IMember[]::new));
        processor.setAbstractMethods(declaredAbstract.toArray(IMethod[]::new));
        processor.setDeletedMethods(deleted.toArray(IMethod[]::new));
        processor.setDestinationType(destination);
        processor.setCreateMethodStubs(true);
        return run(processor, monitor);
    }

    private static Object pushDown(IMember[] members, List<Choice> choices, IProgressMonitor monitor) throws Exception {
        var processor = new PushDownRefactoringProcessor(members);
        var refactoring = new ProcessorBasedRefactoring(processor);
        RefactoringStatus initial = refactoring.checkInitialConditions(monitor);
        if (initial.hasFatalError()) return result(initial, null);
        Map<IMember, Choice> chosen = new LinkedHashMap<>();
        for (Choice choice : choices) chosen.put(choice.member, choice);
        for (MemberActionInfo info : processor.getMemberActionInfos()) {
            Choice choice = chosen.get(info.getMember());
            if (choice == null) info.setAction(MemberActionInfo.NO_ACTION);
            else info.setAction(choice.makeAbstract && info.getMember() instanceof IMethod
                    ? MemberActionInfo.PUSH_ABSTRACT_ACTION : MemberActionInfo.PUSH_DOWN_ACTION);
        }
        RefactoringStatus status = refactoring.checkFinalConditions(monitor);
        initial.merge(status);
        return finish(refactoring, initial, monitor);
    }

    private static Object run(RefactoringProcessor processor, IProgressMonitor monitor) throws Exception {
        var refactoring = new ProcessorBasedRefactoring(processor);
        RefactoringStatus status = refactoring.checkAllConditions(monitor);
        return finish(refactoring, status, monitor);
    }

    private static Object finish(ProcessorBasedRefactoring refactoring, RefactoringStatus status, IProgressMonitor monitor)
            throws Exception {
        cancelled(monitor);
        if (status.hasFatalError()) return result(status, null);
        Change change = refactoring.createChange(monitor);
        cancelled(monitor);
        return result(status, ChangeUtil.convertToWorkspaceEdit(change));
    }

    private static Map<String, Object> member(IMember member, boolean selected, boolean abstractable) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", member.getHandleIdentifier());
        row.put("label", JavaElementLabelsCore.getElementLabel(member, LABEL));
        row.put("kind", member instanceof IMethod ? "method" : member instanceof IField ? "field" : "type");
        row.put("selected", selected);
        row.put("abstractable", abstractable);
        return row;
    }

    private static Map<String, Object> info(IType type, List<Map<String, Object>> targets, List<Map<String, Object>> members) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("className", type.getElementName());
        out.put("targets", targets);
        out.put("members", members);
        return out;
    }

    private static Map<String, Object> result(RefactoringStatus status, Object edit) {
        List<Map<String, Object>> problems = new ArrayList<>();
        for (RefactoringStatusEntry entry : status.getEntries()) {
            String severity = switch (entry.getSeverity()) {
                case RefactoringStatus.FATAL -> "fatal";
                case RefactoringStatus.ERROR -> "error";
                case RefactoringStatus.WARNING -> "warning";
                default -> "info";
            };
            problems.add(Map.of("severity", severity, "message", entry.getMessage()));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("problems", problems);
        out.put("edit", edit);
        return out;
    }

    private static Map<String, Object> refused(String reason) {
        return Map.of("refused", reason);
    }

    private static void cancelled(IProgressMonitor monitor) {
        if (monitor.isCanceled()) throw new OperationCanceledException();
    }
}
