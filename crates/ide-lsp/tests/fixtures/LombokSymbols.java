package demo;

@lombok.Data
@lombok.Builder
class User {
    private String name;
    private int age;
}

@lombok.Getter
@lombok.Setter
@lombok.RequiredArgsConstructor
class Profile {
    private final String id;
    private String name;
}

@lombok.extern.java.Log
class Logged {
    void write() { log.info("hello"); }
}

class PlainUser {
    private String name;
    PlainUser(String name) { this.name = name; }
    String getName() { return name; }
    void setName(String name) { this.name = name; }
}
