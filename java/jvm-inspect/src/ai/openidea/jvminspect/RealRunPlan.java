package ai.openidea.jvminspect;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code ide_streams::RealRunPlan}, from the JSON the client sends with {@code stream.arm}. A malformed
 * plan is an {@link IllegalArgumentException}, which JDT LS answers as an ordinary command error.
 *
 * @param root null when the stream is already held in {@code local}
 * @param stepKinds {@code "sync"}, {@code "reorder"} or {@code "unlinked"}, relating recorded step i to i + 1
 * @param firstLine 0-based line of the statement's first token
 * @param lastLine 0-based line the chain ends on
 */
record RealRunPlan(StepSpec root, String local, List<StepSpec> steps, StepSpec terminal, List<String> classFilters,
        List<String> stepKinds, boolean sequentialize, int firstLine, int lastLine) {

    /**
     * @param args parameter count of the JVM method
     * @param skip only the root's: calls of the same name and arity that exit before it in the statement;
     *     later steps are matched by receiver identity
     */
    record StepSpec(String name, int args, int skip) {
        static StepSpec of(Object json, String what) {
            Map<?, ?> m = member(json, Map.class, what);
            return new StepSpec(member(m.get("name"), String.class, what + ".name"),
                    member(m.get("args"), Number.class, what + ".args").intValue(),
                    member(m.get("skip"), Number.class, what + ".skip").intValue());
        }
    }

    static RealRunPlan of(Object json) {
        Map<?, ?> m = member(json, Map.class, "plan");
        Object root = m.get("root");
        List<StepSpec> steps = new ArrayList<>();
        List<?> rawSteps = member(m.get("steps"), List.class, "plan.steps");
        for (int i = 0; i < rawSteps.size(); i++) steps.add(StepSpec.of(rawSteps.get(i), "plan.steps[" + i + "]"));
        return new RealRunPlan(root == null ? null : StepSpec.of(root, "plan.root"),
                m.get("local") == null ? null : member(m.get("local"), String.class, "plan.local"),
                List.copyOf(steps),
                StepSpec.of(m.get("terminal"), "plan.terminal"),
                strings(m.get("classFilters"), "plan.classFilters"),
                strings(m.get("stepKinds"), "plan.stepKinds"),
                member(m.get("sequentialize"), Boolean.class, "plan.sequentialize"),
                member(m.get("firstLine"), Number.class, "plan.firstLine").intValue(),
                member(m.get("lastLine"), Number.class, "plan.lastLine").intValue());
    }

    private static List<String> strings(Object json, String what) {
        List<?> list = member(json, List.class, what);
        List<String> out = new ArrayList<>(list.size());
        for (int i = 0; i < list.size(); i++) out.add(member(list.get(i), String.class, what + "[" + i + "]"));
        return List.copyOf(out);
    }

    private static <T> T member(Object value, Class<T> type, String what) {
        if (!type.isInstance(value)) throw new IllegalArgumentException(what + " is not a " + type.getSimpleName() + ": " + value);
        return type.cast(value);
    }
}
