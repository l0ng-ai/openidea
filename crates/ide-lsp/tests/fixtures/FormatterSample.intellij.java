package demo;

import java.util.List;
import java.util.function.Function;

@Deprecated
@SuppressWarnings("unused")
public class FormatterSample {
    @Deprecated
    @SuppressWarnings("unused")
    private String first = "first";
    private String second = "second";

    /** A description which remains on a very long single line to check whether formatting introduces wrapping when the right margin is exceeded with ordinary words in a JavaDoc comment. */
    @Deprecated
    @SuppressWarnings("unused")
    public String combine(@Deprecated @SuppressWarnings("unused") String firstParameterWithAVeryLongName,
                          String secondParameterWithAVeryLongName, String thirdParameterWithAVeryLongName) {
        if (firstParameterWithAVeryLongName == null) {
            return "none";
        } else {
            try {
                return List
                        .of(firstParameterWithAVeryLongName, secondParameterWithAVeryLongName,
                                thirdParameterWithAVeryLongName)
                        .stream().map(value -> value.trim()).filter(value -> !value.isEmpty()).findFirst()
                        .orElse("none");
            } catch (RuntimeException problem) {
                throw problem;
            } finally {
                System.out.println("done");
            }
        }
    }

    public void multiline(String firstParameter,
                          String secondParameter,
                          String thirdParameter) {
        combine(firstParameter,
                secondParameter,
                thirdParameter);
        List.of(firstParameter, secondParameter)
                .stream()
                .map(value -> value.trim())
                .forEach(System.out::println);
    }

    public void retained(String firstParameter, // retain declaration break
                         String secondParameter) {
        combine(firstParameter, // retain call break
                secondParameter, "third");
    }

    public void arrays() {
        int[] values = new int[]{1, 2, 3};
        int[] empty = new int[]{};
        Function<String, String> clean = value -> {
            return value.trim();
        };
        Runnable run = () -> {
            System.out.println(values.length);
        };
    }
    // A comment which intentionally exceeds the right margin and should remain unwrapped with the built-in profile even when it contains many ordinary words and spaces to split on.
}
