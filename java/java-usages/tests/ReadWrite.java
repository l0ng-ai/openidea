import lombok.*;
import lombok.experimental.Accessors;
interface Counter { int getCount(); void setCount(int value); }
@Data class Bean implements Counter { public int count; public Bean next; public int[] items; }
class Child extends Bean {}
@Data @Accessors(fluent=true, chain=true) class Fluent { public int score; }
class Use {
 void uses(Bean b, Child c, Counter i, Fluent f) {
  int read = b.count; // read
  b.count = 1; // write
  b.count += 2; // readWrite
  b.count++; // readWrite
  --b.count; // readWrite
  b.setCount(b.getCount()); // setter write, getter read; nested invocation ranges
  c.setCount(c.getCount()); // inherited
  i.setCount(i.getCount()); // interface
  java.util.function.IntSupplier ref = b::getCount; // unknown
  java.util.function.IntConsumer writeRef = b::setCount; // unknown
  f.score = f.score(); // field write, fluent read
  f.score(f.score()); // fluent setter write, getter read
  b.items[0] = 1; // reading array field, writing element
  b.next.count = 2; // reading receiver field, writing count
 }
}
