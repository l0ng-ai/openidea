package ai.openidea.kotlin;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.apache.maven.AbstractMavenLifecycleParticipant;
import org.apache.maven.artifact.Artifact;
import org.apache.maven.MavenExecutionException;
import org.apache.maven.execution.*;
import java.lang.reflect.*;
import org.apache.maven.model.*;
import org.apache.maven.project.MavenProject;
import org.codehaus.plexus.util.xml.Xpp3Dom;

/** Loaded only by the private bridge build, before lifecycle plans are calculated. */
public final class IsolatedOutput extends AbstractMavenLifecycleParticipant {
    private final Map<MavenProject, File> outputs = new LinkedHashMap<>();
    private File staging;
    private final Map<MavenProject, Map<String, String>> kotlin = new LinkedHashMap<>();
    private final Set<MavenProject> sources = new HashSet<>();

    @Override public void afterProjectsRead(MavenSession session) throws MavenExecutionException {
        String destination = session.getUserProperties().getProperty("openidea.kotlin.staging");
        if (destination == null) throw new MavenExecutionException("Missing Kotlin staging directory", (File) null);
        staging = new File(destination);
        int index = 0;
        for (MavenProject project : session.getProjects()) {
            File build = new File(staging, Integer.toString(index++));
            File main = new File(build, "classes");
            File test = new File(build, "test-classes");
            project.getBuild().setDirectory(build.getAbsolutePath());
            project.getBuild().setOutputDirectory(main.getAbsolutePath());
            project.getBuild().setTestOutputDirectory(test.getAbsolutePath());
            for (Plugin plugin : project.getBuildPlugins()) {
                if ("kotlin-maven-plugin".equals(plugin.getArtifactId())) {
                    plugin.setConfiguration(redirect(plugin.getConfiguration(), build, main, test));
                    for (PluginExecution execution : plugin.getExecutions())
                        execution.setConfiguration(redirect(execution.getConfiguration(), build, main, test));
                } else if ("maven-compiler-plugin".equals(plugin.getArtifactId())) {
                    plugin.setConfiguration(compiler(plugin.getConfiguration()));
                    for (PluginExecution execution : plugin.getExecutions())
                        execution.setConfiguration(compiler(execution.getConfiguration()));
                }
            }
            outputs.put(project, main);
            Map<String, String> goals = new LinkedHashMap<>();
            for (Plugin plugin : project.getBuildPlugins()) {
                if (!isKotlin(plugin)) continue;
                for (PluginExecution execution : plugin.getExecutions()) {
                    if ("none".equals(execution.getPhase())) continue;
                    for (String goal : execution.getGoals())
                        if ("compile".equals(goal) || "test-compile".equals(goal))
                            goals.put(execution.getId() + ":" + goal, "skipped");
                }
            }
            kotlin.put(project, goals);
            if (hasKotlin(project.getBasedir().toPath(), project.getBasedir().toPath(), session.getProjects()))
                sources.add(project);
        }
        final ExecutionListener previous = session.getRequest().getExecutionListener();
        // Preserve Maven's logger and any listener installed by another extension.
        session.getRequest().setExecutionListener((ExecutionListener) Proxy.newProxyInstance(
            ExecutionListener.class.getClassLoader(), new Class<?>[] { ExecutionListener.class },
            (proxy, method, args) -> {
                if (args != null && args.length == 1 && args[0] instanceof ExecutionEvent) {
                    ExecutionEvent event = (ExecutionEvent) args[0];
                    if (Arrays.asList("mojoStarted", "mojoSucceeded", "mojoFailed", "mojoSkipped").contains(method.getName())
                        && event.getMojoExecution() != null && isKotlin(event.getMojoExecution().getPlugin())) {
                        String goal = event.getMojoExecution().getGoal();
                        if ("compile".equals(goal) || "test-compile".equals(goal)) {
                            String status = method.getName().equals("mojoSucceeded") ? "success" :
                                method.getName().equals("mojoFailed") ? "failed" : "skipped";
                            Map<String, String> goals = kotlin.get(event.getProject());
                            if (goals != null) goals.put(event.getMojoExecution().getExecutionId() + ":" + goal, status);
                        }
                    }
                }
                if (previous == null) return null;
                try { return method.invoke(previous, args); }
                catch (InvocationTargetException e) { throw e.getCause(); }
            }));
    }

    private static boolean isKotlin(Plugin plugin) {
        return "org.jetbrains.kotlin".equals(plugin.getGroupId()) && "kotlin-maven-plugin".equals(plugin.getArtifactId());
    }
    private static boolean hasKotlin(Path root, Path directory, List<MavenProject> projects) throws MavenExecutionException {
        if (!directory.equals(root)) {
            String name = directory.getFileName().toString();
            if (Arrays.asList("target", "build", "out", "bin", ".git", "node_modules", ".openidea").contains(name)) return false;
            for (MavenProject project : projects) if (project.getBasedir().toPath().equals(directory)) return false;
        }
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) return false;
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory)) {
            for (Path path : entries) {
                if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && path.toString().endsWith(".kt")) return true;
                if (hasKotlin(root, path, projects)) return true;
            }
            return false;
        } catch (IOException e) { throw new MavenExecutionException("Cannot inspect Kotlin sources", e); }
    }

    @Override public void afterSessionEnd(MavenSession session) throws MavenExecutionException {
        if (staging == null) return;
        List<String> modules = new ArrayList<>();
        for (Map.Entry<MavenProject, File> entry : outputs.entrySet()) {
            MavenProject project = entry.getKey();
            File main = entry.getValue();
            List<String> dependencies = new ArrayList<>();
            // Maven has applied dependency management, mediation, scopes, optional
            // propagation and exclusions. Do not reconstruct that graph from POMs.
            for (Artifact dependency : project.getArtifacts()) {
                dependencies.add("{\"key\":" + quote(dependency.getGroupId() + ":" + dependency.getArtifactId() + ":" + dependency.getVersion()) +
                    ",\"scope\":" + quote(dependency.getScope() == null ? "compile" : dependency.getScope()) +
                    ",\"optional\":" + dependency.isOptional() + ",\"type\":" + quote(dependency.getType()) +
                    ",\"classifier\":" + quote(dependency.getClassifier()) + "}");
            }
            List<String> goals = new ArrayList<>();
            for (Map.Entry<String, String> goal : kotlin.get(project).entrySet())
                goals.add("{\"execution\":" + quote(goal.getKey()) + ",\"status\":" + quote(goal.getValue()) + "}");
            modules.add("{\"key\":" + quote(project.getGroupId() + ":" + project.getArtifactId() + ":" + project.getVersion()) +
                ",\"projectUri\":" + quote(project.getBasedir().toURI().toString()) +
                ",\"output\":" + quote(main.getAbsolutePath()) +
                ",\"testOutput\":" + quote(project.getBuild().getTestOutputDirectory()) +
                ",\"hasKotlin\":" + sources.contains(project) +
                ",\"kotlinGoals\":[" + String.join(",", goals) + "]" +
                ",\"dependencies\":[" + String.join(",", dependencies) + "]}");
        }
        try {
            Files.createDirectories(staging.toPath());
            Files.write(new File(staging.getParentFile(), "modules.json").toPath(),
                ("[" + String.join(",", modules) + "]").getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new MavenExecutionException("Cannot write Kotlin module manifest", e);
        }
    }

    private static Xpp3Dom config(Object value) {
        return value instanceof Xpp3Dom ? new Xpp3Dom((Xpp3Dom) value) : new Xpp3Dom("configuration");
    }
    private static void set(Xpp3Dom config, String name, File path) {
        Xpp3Dom child = config.getChild(name);
        if (child == null) { child = new Xpp3Dom(name); config.addChild(child); }
        child.setValue(path.getAbsolutePath());
    }
    private static Xpp3Dom redirect(Object value, File build, File main, File test) {
        Xpp3Dom config = config(value);
        set(config, "output", main);
        set(config, "testOutput", test);
        set(config, "incrementalCachesRoot", new File(build, "kotlin-ic"));
        Xpp3Dom incremental = config.getChild("myIncremental");
        if (incremental == null) { incremental = new Xpp3Dom("myIncremental"); config.addChild(incremental); }
        incremental.setValue("false");
        return config;
    }
    private static Xpp3Dom compiler(Object value) {
        Xpp3Dom config = config(value);
        // compile and testCompile share the parameter name outputDirectory but
        // have different defaults. Let each mojo read the redirected build model.
        for (int i = config.getChildCount() - 1; i >= 0; i--) {
            String name = config.getChild(i).getName();
            if ("outputDirectory".equals(name) || "testOutputDirectory".equals(name)) config.removeChild(i);
        }
        return config;
    }
    private static String quote(String text) {
        if (text == null) return "null";
        StringBuilder out = new StringBuilder("\"");
        for (char c : text.toCharArray()) {
            if (c == '\\' || c == '"') out.append('\\').append(c);
            else if (c < 32) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
}
