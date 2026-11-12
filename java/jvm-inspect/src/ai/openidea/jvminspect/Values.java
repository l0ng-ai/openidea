package ai.openidea.jvminspect;

import com.sun.jdi.ArrayReference;
import com.sun.jdi.BooleanValue;
import com.sun.jdi.ByteValue;
import com.sun.jdi.CharValue;
import com.sun.jdi.ClassType;
import com.sun.jdi.DoubleValue;
import com.sun.jdi.Field;
import com.sun.jdi.FloatValue;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.LongValue;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.ShortValue;
import com.sun.jdi.StringReference;
import com.sun.jdi.Value;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import java.util.function.ToLongFunction;

/**
 * One-line previews in the JSON shape of {@code ide_jvm_inspect::JvmValue}, by the rules of the
 * JDWP link's preview: they only read, never invoke ({@code toString} or otherwise).
 */
final class Values {
    static final int STRING_PREVIEW_CHARS = 1000;
    private static final String STRING = "java.lang.String";
    private static final Set<String> BOXED = Set.of("java.lang.Integer", "java.lang.Long", "java.lang.Short",
            "java.lang.Byte", "java.lang.Character", "java.lang.Boolean", "java.lang.Float", "java.lang.Double");

    /** {@code text} is null when {@code length} exceeds {@link #STRING_PREVIEW_CHARS}. */
    record StringPreview(int length, String text) {}

    /** A field by name, or an array slot as {@code "[i]"}; {@code value} is null for a null reference. */
    record Slot(String name, Value value) {}

    private Values() {}

    /**
     * @param arrayLength length of {@code String.value}
     * @param coder {@code String.coder} (0 = Latin-1, 1 = UTF-16); null on JDK 8, one char per element
     * @param text read only when the string is short
     */
    static StringPreview stringPreview(int arrayLength, Integer coder, Supplier<String> text) {
        int length = coder == null ? arrayLength : arrayLength >>> Math.min(coder & 0xff, 31);
        return new StringPreview(length, length <= STRING_PREVIEW_CHARS ? text.get() : null);
    }

    /** @param handle registers an object the preview hands out and returns its id */
    static Map<String, Object> preview(Value value, ToLongFunction<ObjectReference> handle) {
        if (value == null) return json("kind", "null");
        if (value instanceof PrimitiveValue p) return json("kind", "primitive", "typeName", p.type().name(), "text", text(p));
        ObjectReference object = (ObjectReference) value;
        long id = handle.applyAsLong(object);
        String type = object.referenceType().name();
        if (object instanceof ArrayReference array) return json("kind", "array", "id", id, "typeName", type, "length", array.length());
        if (type.equals(STRING)) {
            StringPreview s = string(object);
            return json("kind", "string", "id", id, "text", s.text(), "length", s.length());
        }
        if (BOXED.contains(type)) return json("kind", "boxed", "id", id, "typeName", type, "text", boxedText(object));
        return json("kind", "object", "id", id, "typeName", type);
    }

    /** Every instance field, the object's own class first, then each superclass; static fields are skipped. */
    static List<Slot> instanceFields(ObjectReference object) {
        List<Field> fields = new ArrayList<>();
        for (ReferenceType t = object.referenceType(); t != null; t = t instanceof ClassType c ? c.superclass() : null) {
            for (Field f : t.fields()) {
                if (!f.isStatic()) fields.add(f);
            }
        }
        if (fields.isEmpty()) return List.of();
        Map<Field, Value> values = object.getValues(fields);
        return fields.stream().map(f -> new Slot(f.name(), values.get(f))).toList();
    }

    /** The first {@code count} elements, named {@code "[i]"}. */
    static List<Slot> elements(ArrayReference array, int count) {
        if (count == 0) return List.of();
        List<Value> values = array.getValues(0, count);
        List<Slot> out = new ArrayList<>(values.size());
        for (int i = 0; i < values.size(); i++) out.add(new Slot("[" + i + "]", values.get(i)));
        return out;
    }

    static Map<String, Object> json(Object... keysAndValues) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < keysAndValues.length; i += 2) m.put((String) keysAndValues[i], keysAndValues[i + 1]);
        return m;
    }

    /** Reads the length of the backing array, and the text only when it is short. */
    private static StringPreview string(ObjectReference object) {
        ClassType type = (ClassType) object.referenceType();
        Field value = instanceField(type, "value");
        if (value == null) throw new IllegalStateException(STRING + " has no value field");
        Field coder = instanceField(type, "coder");
        Map<Field, Value> read = object.getValues(coder == null ? List.of(value) : List.of(value, coder));
        int arrayLength = read.get(value) instanceof ArrayReference array ? array.length() : 0;
        Integer c = coder == null ? null : (int) ((ByteValue) read.get(coder)).value();
        return stringPreview(arrayLength, c, () -> ((StringReference) object).value());
    }

    private static String boxedText(ObjectReference object) {
        Field value = instanceField((ClassType) object.referenceType(), "value");
        if (value == null) throw new IllegalStateException("a boxed type has no value field");
        return text((PrimitiveValue) object.getValue(value));
    }

    /** Declared in {@code type} itself, not inherited. */
    private static Field instanceField(ReferenceType type, String name) {
        for (Field f : type.fields()) {
            if (f.name().equals(name) && !f.isStatic()) return f;
        }
        return null;
    }

    /** As Java prints it; a lone surrogate becomes U+FFFD like the JDWP link's preview. */
    private static String text(PrimitiveValue p) {
        return switch (p) {
            case BooleanValue v -> Boolean.toString(v.value());
            case ByteValue v -> Byte.toString(v.value());
            case CharValue v -> Character.isSurrogate(v.value()) ? "�" :String.valueOf(v.value());
            case ShortValue v -> Short.toString(v.value());
            case IntegerValue v -> Integer.toString(v.value());
            case LongValue v -> Long.toString(v.value());
            case FloatValue v -> Float.toString(v.value());
            case DoubleValue v -> Double.toString(v.value());
            default -> p.toString();
        };
    }
}
