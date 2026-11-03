import java.math.BigDecimal;
import java.util.List;
import lombok.Builder;
import lombok.NonNull;
import lombok.Singular;

public class BuilderCompactConstructor {
    @Builder(toBuilder = true)
    record Payment(String number, String phone, BigDecimal amount,
                   BigDecimal serviceCharge, BigDecimal total, Status status) {
        @Builder
        Payment {
            if (serviceCharge == null) serviceCharge = BigDecimal.ZERO;
        }
    }

    enum Status { PENDING, SUCCESS, EXPIRED }

    record ConstructorOnly(String name, int count) {
        @Builder(toBuilder = true, setterPrefix = "with")
        ConstructorOnly {
            if (count < 0) throw new IllegalArgumentException("count");
        }
    }

    @Builder(toBuilder = true)
    record TypeOnly(int count) {
        TypeOnly { count++; }
    }

    record Generic<T>(@NonNull T value, @Singular List<String> tags) {
        static final String IGNORED = "not a component";

        @Builder(toBuilder = true)
        Generic {}
    }

    record Empty() {
        @Builder
        Empty {}
    }

    record Explicit(String name, int count) {
        @Builder
        Explicit(String name) { this(name, 7); }
    }

    static class Ordinary {
        final String name;

        @Builder
        Ordinary(String name) { this.name = name; }
    }

    @Builder(builderMethodName = "methodBuilder", builderClassName = "MethodBuilder")
    static String named(String name) { return name; }

    public static void main(String[] args) {
        var payment = Payment.builder().number("inquiry").phone("123")
            .amount(BigDecimal.TEN).total(BigDecimal.TEN).status(Status.PENDING).build();
        assert payment.number().equals("inquiry");
        assert payment.phone().equals("123");
        assert payment.amount().equals(BigDecimal.TEN);
        assert payment.serviceCharge().equals(BigDecimal.ZERO);
        assert payment.total().equals(BigDecimal.TEN);
        assert payment.status() == Status.PENDING;
        assert payment.toBuilder().phone("456").build().phone().equals("456");
        assert Payment.builder().serviceCharge(BigDecimal.ONE).build().serviceCharge().equals(BigDecimal.ONE);

        var constructor = ConstructorOnly.builder().withName("test").withCount(2).build();
        assert constructor.toBuilder().withCount(3).build().count() == 3;
        assert constructor.name().equals("test");
        try {
            ConstructorOnly.builder().withCount(-1).build();
            throw new AssertionError("compact constructor validation was bypassed");
        } catch (IllegalArgumentException expected) {}

        assert TypeOnly.builder().count(2).build().count() == 3;
        assert Empty.builder().build().equals(new Empty());
        var generic = Generic.<String>builder().value("value").tag("one").build();
        assert generic.value().equals("value");
        assert generic.tags().equals(List.of("one"));
        assert generic.toBuilder().tag("two").build().tags().equals(List.of("one", "two"));
        try {
            Generic.<String>builder().build();
            throw new AssertionError("non-null check was bypassed");
        } catch (NullPointerException expected) {}

        assert Explicit.builder().name("test").build().equals(new Explicit("test", 7));
        assert Ordinary.builder().name("test").build().name.equals("test");
        assert methodBuilder().name("test").build().equals("test");
    }
}
