package ai.openidea.javac.maven;

import java.io.File;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.maven.AbstractMavenLifecycleParticipant;
import org.apache.maven.MavenExecutionException;
import org.apache.maven.execution.MavenSession;
import org.apache.maven.lifecycle.LifecycleExecutor;
import org.apache.maven.lifecycle.MavenExecutionPlan;
import org.apache.maven.model.Dependency;
import org.apache.maven.model.Resource;
import org.apache.maven.plugin.BuildPluginManager;
import org.apache.maven.plugin.MavenPluginManager;
import org.apache.maven.plugin.Mojo;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.project.DefaultDependencyResolutionRequest;
import org.apache.maven.project.DependencyResolutionResult;
import org.apache.maven.project.MavenProject;
import org.apache.maven.project.ProjectDependenciesResolver;
import javax.inject.Inject;
import javax.inject.Named;
import javax.inject.Singleton;
import org.eclipse.aether.DefaultRepositorySystemSession;
import org.eclipse.aether.RepositorySystem;
import org.eclipse.aether.RepositorySystemSession;
import org.eclipse.aether.artifact.Artifact;
import org.eclipse.aether.artifact.DefaultArtifact;
import org.eclipse.aether.collection.CollectRequest;
import org.eclipse.aether.graph.DependencyNode;
import org.eclipse.aether.graph.Exclusion;
import org.eclipse.aether.repository.WorkspaceReader;
import org.eclipse.aether.repository.WorkspaceRepository;
import org.eclipse.aether.resolution.ArtifactResult;
import org.eclipse.aether.resolution.DependencyRequest;
import org.eclipse.aether.resolution.DependencyResult;

/**
 * Records how each project of the session compiles, for the IDE's own Java build. Loaded only
 * by the IDE's prepare run ({@code -Dmaven.ext.class.path=<jar> -Dopenidea.build.model=<file>
 * process-resources resources:testResources}): generated sources exist and resources are
 * processed, and nothing is compiled. Test source generators run after {@code compile} in
 * Maven's lifecycle, so they don't run; the source roots build-helper adds are read from its
 * configuration, and any other generator is listed so the IDE leaves those tests to Maven.
 *
 * <p>Per project and source set (main, test): the source roots (including the ones generated
 * sources added), the output directory, the compile classpath with reactor projects as their
 * output directories (never their jars), the runtime classpath, the compiler plugin's resolved
 * configuration (release, encoding, arguments, annotation processor path) and the resources.
 * Executions bound to the compile phases that are not javac (Kotlin, AspectJ, bytecode
 * enhancers) are listed, so the IDE leaves such projects to Maven.
 */
@Named("openidea-build-model")
@Singleton
public final class BuildModel extends AbstractMavenLifecycleParticipant {
    private static final String COMPILER = "org.apache.maven.plugins:maven-compiler-plugin";
    /** Test phases before test-compile, which the prepare run doesn't reach. */
    private static final Set<String> TEST_GENERATE_PHASES = new HashSet<>(Arrays.asList(
        "generate-test-sources", "process-test-sources", "generate-test-resources", "process-test-resources"));
    /** Phases whose executions change what the compile phases produce. */
    private static final Set<String> COMPILE_PHASES =
        new HashSet<>(Arrays.asList("compile", "process-classes", "test-compile", "process-test-classes"));
    /** Executions in those phases that don't change the classes the IDE compiles. */
    private static final Set<String> HARMLESS = new HashSet<>(Arrays.asList(
        "org.jacoco:jacoco-maven-plugin", "org.apache.maven.plugins:maven-enforcer-plugin",
        "org.codehaus.mojo:animal-sniffer-maven-plugin", "org.apache.maven.plugins:maven-checkstyle-plugin",
        "com.github.spotbugs:spotbugs-maven-plugin", "org.apache.maven.plugins:maven-pmd-plugin",
        "com.diffplug.spotless:spotless-maven-plugin", "org.apache.maven.plugins:maven-dependency-plugin",
        "org.apache.maven.plugins:maven-resources-plugin", "org.codehaus.mojo:build-helper-maven-plugin",
        "pl.project13.maven:git-commit-id-plugin", "io.github.git-commit-id:git-commit-id-maven-plugin"));

    private final LifecycleExecutor lifecycle;
    private final MavenPluginManager plugins;
    private final BuildPluginManager buildPlugins;
    private final ProjectDependenciesResolver dependencies;
    private final RepositorySystem repositories;

    @Inject
    public BuildModel(LifecycleExecutor lifecycle, MavenPluginManager plugins, BuildPluginManager buildPlugins,
                      ProjectDependenciesResolver dependencies, RepositorySystem repositories) {
        this.lifecycle = lifecycle;
        this.plugins = plugins;
        this.buildPlugins = buildPlugins;
        this.dependencies = dependencies;
        this.repositories = repositories;
    }

    /**
     * With {@code -Dopenidea.build.output=<dir>}, every project's classes and resources go to
     * {@code <dir>/<groupId>.<artifactId>/classes} (and {@code test-classes}): the IDE's outputs,
     * apart from what a terminal build or the language server writes to {@code target}.
     */
    @Override public void afterProjectsRead(MavenSession session) {
        String output = session.getUserProperties().getProperty("openidea.build.output");
        if (output == null) return;
        for (MavenProject project : session.getProjects()) {
            File dir = new File(output, project.getGroupId() + "." + project.getArtifactId());
            project.getBuild().setOutputDirectory(new File(dir, "classes").getAbsolutePath());
            project.getBuild().setTestOutputDirectory(new File(dir, "test-classes").getAbsolutePath());
        }
    }

    @Override public void afterSessionEnd(MavenSession session) throws MavenExecutionException {
        String destination = session.getUserProperties().getProperty("openidea.build.model");
        if (destination == null) return;
        StringBuilder json = new StringBuilder("{\"version\":1,\"projects\":[");
        boolean first = true;
        MavenProject current = session.getCurrentProject();
        try {
            for (MavenProject project : session.getProjects()) {
                if (!first) json.append(',');
                first = false;
                project(json, session, project);
            }
        } finally {
            session.setCurrentProject(current);
        }
        json.append("]}");
        File target = new File(destination);
        try {
            File parent = target.getAbsoluteFile().getParentFile();
            parent.mkdirs();
            File temp = File.createTempFile("build-model", ".json", parent);
            try (Writer out = new OutputStreamWriter(Files.newOutputStream(temp.toPath()), StandardCharsets.UTF_8)) {
                out.write(json.toString());
            }
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            throw new MavenExecutionException("Cannot write the IDE build model: " + e.getMessage(), e);
        }
    }

    private void project(StringBuilder json, MavenSession session, MavenProject project) {
        session.setCurrentProject(project);
        json.append("{\"dir\":").append(q(project.getBasedir().getAbsolutePath()))
            .append(",\"groupId\":").append(q(project.getGroupId()))
            .append(",\"artifactId\":").append(q(project.getArtifactId()))
            .append(",\"version\":").append(q(project.getVersion()))
            .append(",\"packaging\":").append(q(project.getPackaging()));
        List<String> problems = new ArrayList<>();
        Map<String, Mojo> compilers = new HashMap<>();
        List<MojoExecution> configured = new ArrayList<>();
        List<String> others = new ArrayList<>();
        List<String> testGenerators = new ArrayList<>();
        List<String> testRoots = new ArrayList<>(project.getTestCompileSourceRoots());
        try {
            MavenExecutionPlan plan = lifecycle.calculateExecutionPlan(session, true, "test-compile");
            for (MojoExecution execution : plan.getMojoExecutions()) {
                String plugin = execution.getGroupId() + ":" + execution.getArtifactId();
                String phase = execution.getLifecyclePhase();
                if (COMPILER.equals(plugin) && ("compile".equals(execution.getGoal()) || "testCompile".equals(execution.getGoal()))) {
                    if (compilers.containsKey(execution.getGoal())) {
                        others.add(plugin + ":" + execution.getGoal() + "@" + execution.getExecutionId());
                        continue;
                    }
                    try {
                        buildPlugins.getPluginRealm(session, execution.getMojoDescriptor().getPluginDescriptor());
                        Mojo mojo = plugins.getConfiguredMojo(Mojo.class, session, execution);
                        compilers.put(execution.getGoal(), mojo);
                        configured.add(execution);
                    } catch (Exception e) {
                        problems.add("Cannot read the " + execution.getGoal() + " configuration: " + e);
                    }
                } else if (phase != null && COMPILE_PHASES.contains(phase) && !HARMLESS.contains(plugin)) {
                    others.add(plugin + ":" + execution.getGoal() + "@" + execution.getExecutionId());
                } else if (phase != null && TEST_GENERATE_PHASES.contains(phase)) {
                    String goal = plugin + ":" + execution.getGoal();
                    if (goal.equals("org.apache.maven.plugins:maven-resources-plugin:testResources")) continue;
                    if (goal.equals("org.codehaus.mojo:build-helper-maven-plugin:add-test-source")) {
                        try {
                            buildPlugins.getPluginRealm(session, execution.getMojoDescriptor().getPluginDescriptor());
                            Mojo mojo = plugins.getConfiguredMojo(Mojo.class, session, execution);
                            Object sources = get(mojo, "sources");
                            if (sources instanceof File[])
                                for (File f : (File[]) sources) testRoots.add(f.getAbsolutePath());
                            plugins.releaseMojo(mojo, execution);
                            continue;
                        } catch (Exception e) {
                            problems.add("Cannot read build-helper's test sources: " + e);
                        }
                    }
                    testGenerators.add(goal + "@" + execution.getExecutionId());
                }
            }
        } catch (Exception e) {
            problems.add("Cannot plan the build: " + e);
        }
        Set<String> reactor = new HashSet<>();
        for (MavenProject p : session.getProjects()) reactor.add(p.getGroupId() + ":" + p.getArtifactId());
        RepositorySystemSession repo = reactorSession(session);
        List<String> compile = new ArrayList<>();
        List<String> runtime = new ArrayList<>();
        List<String> test = new ArrayList<>();
        try {
            DependencyResolutionResult result =
                dependencies.resolve(new DefaultDependencyResolutionRequest(project, repo));
            classpaths(result.getDependencyGraph(), compile, runtime, test);
            for (Exception e : result.getCollectionErrors()) problems.add(e.getMessage());
        } catch (Exception e) {
            problems.add("Cannot resolve the dependencies: " + rootMessage(e));
            org.apache.maven.project.DependencyResolutionException failure = cause(e);
            if (failure != null && failure.getResult() != null && failure.getResult().getDependencyGraph() != null)
                classpaths(failure.getResult().getDependencyGraph(), compile, runtime, test);
        }
        json.append(",\"main\":");
        sourceSet(json, session, project, compilers.get("compile"), null, compile, runtime, problems);
        json.append(",\"test\":");
        List<String> testClasspath = new ArrayList<>();
        testClasspath.add(project.getBuild().getOutputDirectory());
        testClasspath.addAll(test);
        sourceSet(json, session, project, compilers.get("testCompile"), testRoots, testClasspath, testClasspath, problems);
        json.append(",\"otherCompilers\":").append(strings(others));
        json.append(",\"testGenerators\":").append(strings(testGenerators));
        json.append(",\"problems\":").append(strings(problems)).append('}');
        for (int i = 0; i < configured.size(); i++) {
            Mojo mojo = compilers.get(configured.get(i).getGoal());
            if (mojo != null) plugins.releaseMojo(mojo, configured.get(i));
        }
    }

    /** `testRoots`: the test source roots, `null` for the main source set. */
    private void sourceSet(StringBuilder json, MavenSession session, MavenProject project, Mojo compiler,
                           List<String> testRoots, List<String> classpath, List<String> runtime, List<String> problems) {
        boolean test = testRoots != null;
        List<String> roots = test ? testRoots : project.getCompileSourceRoots();
        String output = test ? project.getBuild().getTestOutputDirectory() : project.getBuild().getOutputDirectory();
        json.append("{\"sourceRoots\":").append(strings(roots))
            .append(",\"output\":").append(q(output))
            .append(",\"classpath\":").append(strings(classpath))
            .append(",\"runtimeClasspath\":").append(strings(runtime))
            .append(",\"resources\":");
        List<Resource> resources = test ? project.getTestResources() : project.getResources();
        json.append('[');
        for (int i = 0; i < resources.size(); i++) {
            Resource r = resources.get(i);
            if (i > 0) json.append(',');
            json.append("{\"directory\":").append(q(new File(project.getBasedir(), r.getDirectory()).isAbsolute()
                    ? r.getDirectory() : new File(project.getBasedir(), r.getDirectory()).getAbsolutePath()))
                .append(",\"filtering\":").append(r.isFiltering())
                .append(",\"targetPath\":").append(q(r.getTargetPath()))
                .append(",\"includes\":").append(strings(r.getIncludes()))
                .append(",\"excludes\":").append(strings(r.getExcludes())).append('}');
        }
        json.append(']');
        json.append(",\"compiler\":");
        if (compiler == null) {
            json.append("null}");
            return;
        }
        json.append('{');
        String goal = test ? "testCompile" : "compile";
        field(json, "compilerId", get(compiler, "compilerId"));
        field(json, "source", get(compiler, test ? "testSource" : "source", "source"));
        field(json, "target", get(compiler, test ? "testTarget" : "target", "target"));
        field(json, "release", get(compiler, test ? "testRelease" : "release", "release"));
        field(json, "encoding", get(compiler, "encoding"));
        field(json, "parameters", get(compiler, "parameters"));
        field(json, "debug", get(compiler, "debug"));
        field(json, "debuglevel", get(compiler, "debuglevel"));
        field(json, "proc", get(compiler, "proc"));
        field(json, "enablePreview", get(compiler, "enablePreview"));
        field(json, "fork", get(compiler, "fork"));
        field(json, "executable", get(compiler, "executable"));
        field(json, "skip", get(compiler, test ? "skip" : "skipMain"));
        field(json, "showWarnings", get(compiler, "showWarnings"));
        field(json, "showDeprecation", get(compiler, "showDeprecation"));
        field(json, "generatedSourcesDirectory",
            get(compiler, test ? "generatedTestSourcesDirectory" : "generatedSourcesDirectory"));
        field(json, "includes", get(compiler, test ? "testIncludes" : "includes"));
        field(json, "excludes", get(compiler, test ? "testExcludes" : "excludes"));
        field(json, "annotationProcessors", get(compiler, "annotationProcessors"));
        field(json, "compilerArgs", get(compiler, "compilerArgs"));
        field(json, "compilerArgument", get(compiler, "compilerArgument"));
        field(json, "compilerArguments", get(compiler, "compilerArguments"));
        field(json, "multiReleaseOutput", get(compiler, "multiReleaseOutput"));
        Object paths = get(compiler, "annotationProcessorPaths");
        if (paths instanceof Collection && !((Collection<?>) paths).isEmpty()) {
            try {
                Object useDepMgmt = get(compiler, "annotationProcessorPathsUseDepMgmt");
                field(json, "processorPath", processorPath(session, project, (Collection<?>) paths,
                    Boolean.TRUE.equals(useDepMgmt)));
            } catch (Exception e) {
                problems.add("Cannot resolve the annotation processor path of " + goal + ": " + rootMessage(e));
                field(json, "processorPathError", rootMessage(e));
            }
        }
        if (json.charAt(json.length() - 1) == ',') json.setLength(json.length() - 1);
        json.append("}}");
    }

    /**
     * The classpaths of the resolved graph, in Maven's order: compile, runtime, test scopes. A
     * {@code system} jar is on the runtime classpath too: it is an explicit file the launched JVM
     * must load (IDEA imports the scope as Compile), while {@code provided} is the container's.
     */
    private static void classpaths(DependencyNode root, List<String> compile, List<String> runtime, List<String> test) {
        List<DependencyNode> nodes = new ArrayList<>();
        collect(root, nodes, new HashSet<>());
        for (DependencyNode node : nodes) {
            if (node.getDependency() == null || node.getArtifact() == null) continue;
            File file = node.getArtifact().getFile();
            if (file == null) continue;
            String scope = node.getDependency().getScope();
            String path = file.getAbsolutePath();
            if (!"test".equals(scope) && !"runtime".equals(scope)) compile.add(path);
            if (!"test".equals(scope) && !"provided".equals(scope)) runtime.add(path);
            test.add(path);
        }
    }

    /** Pre-order, as Maven lists `project.getArtifacts()` for classpaths. */
    private static void collect(DependencyNode node, List<DependencyNode> out, Set<String> seen) {
        for (DependencyNode child : node.getChildren()) {
            Artifact a = child.getArtifact();
            String key = a == null ? String.valueOf(System.identityHashCode(child))
                : a.getGroupId() + ":" + a.getArtifactId() + ":" + a.getExtension() + ":" + a.getClassifier();
            if (seen.add(key)) out.add(child);
        }
        for (DependencyNode child : node.getChildren()) collect(child, out, seen);
    }

    /**
     * A repository session that resolves reactor projects to their output directories, as the
     * IDE compiles against them: before (and without) any packaging, and even before they exist.
     */
    private static RepositorySystemSession reactorSession(MavenSession session) {
        final Map<String, MavenProject> byKey = new HashMap<>();
        for (MavenProject p : session.getProjects())
            byKey.put(p.getGroupId() + ":" + p.getArtifactId() + ":" + p.getVersion(), p);
        final WorkspaceReader fallback = session.getRepositorySession().getWorkspaceReader();
        final WorkspaceRepository repository = new WorkspaceRepository("openidea-reactor");
        WorkspaceReader reader = new WorkspaceReader() {
            @Override public WorkspaceRepository getRepository() {
                return repository;
            }

            @Override public File findArtifact(Artifact artifact) {
                MavenProject p = byKey.get(artifact.getGroupId() + ":" + artifact.getArtifactId() + ":" + artifact.getBaseVersion());
                if (p == null) return fallback == null ? null : fallback.findArtifact(artifact);
                if ("pom".equals(artifact.getExtension())) return p.getFile();
                boolean tests = "tests".equals(artifact.getClassifier()) || "test-jar".equals(artifact.getProperty("type", ""));
                File dir = new File(tests ? p.getBuild().getTestOutputDirectory() : p.getBuild().getOutputDirectory());
                dir.mkdirs();
                return dir;
            }

            @Override public List<String> findVersions(Artifact artifact) {
                MavenProject p = byKey.get(artifact.getGroupId() + ":" + artifact.getArtifactId() + ":" + artifact.getBaseVersion());
                if (p != null) return java.util.Collections.singletonList(p.getVersion());
                return fallback == null ? java.util.Collections.<String>emptyList() : fallback.findVersions(artifact);
            }
        };
        DefaultRepositorySystemSession copy = new DefaultRepositorySystemSession(session.getRepositorySession());
        copy.setWorkspaceReader(reader);
        return copy;
    }

    /** maven-compiler-plugin's `annotationProcessorPaths`, resolved with their dependencies as the plugin does. */
    private List<String> processorPath(MavenSession session, MavenProject project, Collection<?> coordinates,
                                       boolean useDepMgmt) throws Exception {
        Map<String, String> managed = new HashMap<>();
        if (project.getDependencyManagement() != null)
            for (Dependency d : project.getDependencyManagement().getDependencies())
                managed.put(d.getGroupId() + ":" + d.getArtifactId(), d.getVersion());
        CollectRequest request = new CollectRequest();
        request.setRepositories(project.getRemoteProjectRepositories());
        for (Object c : coordinates) {
            String group = (String) get(c, "groupId");
            String artifact = (String) get(c, "artifactId");
            String version = (String) get(c, "version");
            if (version == null) version = managed.get(group + ":" + artifact);
            if (version == null) throw new IllegalStateException("No version for " + group + ":" + artifact);
            String classifier = (String) get(c, "classifier");
            String type = (String) get(c, "type");
            List<Exclusion> exclusions = new ArrayList<>();
            Object declared = get(c, "exclusions");
            if (declared instanceof Collection)
                for (Object e : (Collection<?>) declared)
                    exclusions.add(new Exclusion((String) get(e, "groupId"), (String) get(e, "artifactId"), "*", "*"));
            DefaultArtifact a = new DefaultArtifact(group, artifact, classifier == null ? "" : classifier,
                type == null || "jar".equals(type) ? "jar" : type, version);
            request.addDependency(new org.eclipse.aether.graph.Dependency(a, "runtime", false, exclusions));
        }
        if (useDepMgmt && project.getDependencyManagement() != null) {
            for (Dependency d : project.getDependencyManagement().getDependencies()) {
                request.addManagedDependency(new org.eclipse.aether.graph.Dependency(new DefaultArtifact(d.getGroupId(),
                    d.getArtifactId(), d.getClassifier() == null ? "" : d.getClassifier(),
                    d.getType() == null ? "jar" : d.getType(), d.getVersion()), d.getScope()));
            }
        }
        DependencyResult result =
            repositories.resolveDependencies(reactorSession(session), new DependencyRequest(request, null));
        Set<String> out = new LinkedHashSet<>();
        for (ArtifactResult r : result.getArtifactResults())
            if (r.getArtifact() != null && r.getArtifact().getFile() != null) out.add(r.getArtifact().getFile().getAbsolutePath());
        return new ArrayList<>(out);
    }

    private static org.apache.maven.project.DependencyResolutionException cause(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause())
            if (t instanceof org.apache.maven.project.DependencyResolutionException)
                return (org.apache.maven.project.DependencyResolutionException) t;
        return null;
    }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        return t.getMessage() == null ? t.toString() : t.getMessage();
    }

    /** The first of `names` that a field of the mojo (or its superclasses) has, read reflectively. */
    private static Object get(Object target, String... names) {
        for (String name : names) {
            for (Class<?> c = target.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
                try {
                    Field f = c.getDeclaredField(name);
                    f.setAccessible(true);
                    Object value = f.get(target);
                    if (value != null || names.length == 1) return value;
                    break;
                } catch (NoSuchFieldException e) {
                    // Try the superclass.
                } catch (IllegalAccessException | RuntimeException e) {
                    return null;
                }
            }
        }
        return null;
    }

    private static void field(StringBuilder json, String name, Object value) {
        if (value == null) return;
        json.append(q(name)).append(':').append(value(value)).append(',');
    }

    private static String value(Object value) {
        if (value == null) return "null";
        if (value instanceof Boolean || value instanceof Number) return value.toString();
        if (value instanceof File) return q(((File) value).getAbsolutePath());
        if (value instanceof Collection) {
            StringBuilder b = new StringBuilder("[");
            for (Object o : (Collection<?>) value) {
                if (b.length() > 1) b.append(',');
                b.append(value(o));
            }
            return b.append(']').toString();
        }
        if (value instanceof Object[]) return value(Arrays.asList((Object[]) value));
        if (value instanceof Map) {
            StringBuilder b = new StringBuilder("{");
            for (Map.Entry<?, ?> e : new LinkedHashMap<>((Map<?, ?>) value).entrySet()) {
                if (b.length() > 1) b.append(',');
                b.append(q(String.valueOf(e.getKey()))).append(':').append(q(e.getValue() == null ? null : String.valueOf(e.getValue())));
            }
            return b.append('}').toString();
        }
        return q(value.toString());
    }

    private static String strings(Collection<String> values) {
        StringBuilder b = new StringBuilder("[");
        if (values != null) {
            for (String s : values) {
                if (b.length() > 1) b.append(',');
                b.append(q(s));
            }
        }
        return b.append(']').toString();
    }

    static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }
}
