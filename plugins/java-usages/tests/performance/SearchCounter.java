import java.lang.instrument.*;
import java.security.ProtectionDomain;
import org.objectweb.asm.*;
public class SearchCounter {
 public static void premain(String args,Instrumentation instrumentation) {
  instrumentation.addTransformer(new ClassFileTransformer() {
   public byte[] transform(ClassLoader loader,String name,Class<?> c,ProtectionDomain domain,byte[] bytes) {
    boolean handler=name.equals("org/eclipse/jdt/ls/core/internal/handlers/ReferencesHandler");
    boolean engine=name.equals("org/eclipse/jdt/core/search/SearchEngine");
    if(!handler&&!engine)return null;
    ClassReader reader=new ClassReader(bytes);ClassWriter writer=new ClassWriter(reader,ClassWriter.COMPUTE_MAXS);
    reader.accept(new ClassVisitor(Opcodes.ASM9,writer) {
     public MethodVisitor visitMethod(int access,String method,String descriptor,String signature,String[] exceptions) {
      MethodVisitor mv=super.visitMethod(access,method,descriptor,signature,exceptions);
      boolean target=method.equals("search") && (handler || descriptor.startsWith("(Lorg/eclipse/jdt/core/search/SearchPattern;[Lorg/eclipse/jdt/core/search/SearchParticipant;"));
      if(!target)return mv;
      return new MethodVisitor(Opcodes.ASM9,mv) {
       public void visitCode(){super.visitCode();String property=handler?"probe.handler":"probe.engine";
        mv.visitLdcInsn(property);mv.visitLdcInsn(property);mv.visitLdcInsn("0");
        mv.visitMethodInsn(Opcodes.INVOKESTATIC,"java/lang/System","getProperty","(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",false);
        mv.visitMethodInsn(Opcodes.INVOKESTATIC,"java/lang/Integer","parseInt","(Ljava/lang/String;)I",false);
        mv.visitInsn(Opcodes.ICONST_1);mv.visitInsn(Opcodes.IADD);
        mv.visitMethodInsn(Opcodes.INVOKESTATIC,"java/lang/Integer","toString","(I)Ljava/lang/String;",false);
        mv.visitMethodInsn(Opcodes.INVOKESTATIC,"java/lang/System","setProperty","(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",false);mv.visitInsn(Opcodes.POP);
       }
      };
     }
    },0);return writer.toByteArray();
   }
  });
 }
}
