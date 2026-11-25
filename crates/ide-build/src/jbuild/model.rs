//! The build model of a Maven reactor as Maven itself configures it, recorded by the
//! prepare run's extension (`java/java-build`, `BuildModel`), and when that run is due.
use super::*;
use std::fs;

/// `model.json` of the prepare run (see `BuildModel.java`).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactorModel {
    pub version: u32,
    pub projects: Vec<ProjectModel>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModel {
    /// Absolute project directory.
    pub dir: PathBuf,
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
    pub packaging: String,
    pub main: SourceSet,
    pub test: SourceSet,
    /// Executions in the compile phases that aren't javac (`group:artifact:goal@id`).
    #[serde(default)]
    pub other_compilers: Vec<String>,
    /// Test source generators the prepare run doesn't reach.
    #[serde(default)]
    pub test_generators: Vec<String>,
    #[serde(default)]
    pub problems: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSet {
    pub source_roots: Vec<PathBuf>,
    pub output: PathBuf,
    pub classpath: Vec<PathBuf>,
    pub runtime_classpath: Vec<PathBuf>,
    #[serde(default)]
    pub resources: Vec<ResourceRoot>,
    pub compiler: Option<CompilerConfig>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRoot {
    pub directory: PathBuf,
    #[serde(default)]
    pub filtering: bool,
    pub target_path: Option<String>,
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
}

/// maven-compiler-plugin's configuration of one source set, as its mojo was configured.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompilerConfig {
    pub compiler_id: Option<String>,
    pub source: Option<String>,
    pub target: Option<String>,
    pub release: Option<String>,
    pub encoding: Option<String>,
    pub parameters: Option<bool>,
    pub debug: Option<bool>,
    pub debuglevel: Option<String>,
    pub proc: Option<String>,
    pub enable_preview: Option<bool>,
    pub fork: Option<bool>,
    pub executable: Option<String>,
    pub skip: Option<bool>,
    pub show_warnings: Option<bool>,
    pub show_deprecation: Option<bool>,
    pub generated_sources_directory: Option<PathBuf>,
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
    pub annotation_processors: Option<Vec<String>>,
    #[serde(default)]
    pub compiler_args: Vec<String>,
    pub compiler_argument: Option<String>,
    #[serde(default)]
    pub compiler_arguments: BTreeMap<String, Option<String>>,
    pub multi_release_output: Option<bool>,
    pub processor_path: Option<Vec<PathBuf>>,
    pub processor_path_error: Option<String>,
}

impl ProjectModel {
    pub fn key(&self) -> String {
        format!("{}:{}", self.group_id, self.artifact_id)
    }

    pub fn set(&self, test: bool) -> &SourceSet {
        if test { &self.test } else { &self.main }
    }

    /// Why the IDE can't compile this project with javac itself, if it can't.
    pub fn unsupported(&self, test: bool) -> Option<String> {
        if !self.other_compilers.is_empty() {
            return Some(format!("{} also compiles with {}", self.artifact_id, self.other_compilers.join(", ")));
        }
        if test && !self.test_generators.is_empty() {
            return Some(format!(
                "{} generates test sources with {}",
                self.artifact_id,
                self.test_generators.join(", ")
            ));
        }
        for set in [&self.main, &self.test] {
            let Some(c) = &set.compiler else { continue };
            if c.compiler_id.as_deref().is_some_and(|id| id != "javac") {
                return Some(format!("{} compiles with {}", self.artifact_id, c.compiler_id.as_deref().unwrap()));
            }
            if c.multi_release_output == Some(true) {
                return Some(format!("{} is a multi-release jar", self.artifact_id));
            }
            if let Some(error) = &c.processor_path_error {
                return Some(format!("{}: {error}", self.artifact_id));
            }
        }
        None
    }
}

/// Where the IDE's build of the reactor at `top_dir` keeps its model and outputs.
pub(super) fn reactor_dir(cache: &Path, top_dir: &str) -> PathBuf {
    let base = cache.join("java-build");
    if top_dir.is_empty() { base.join("_root") } else { base.join(top_dir) }
}

/// The outputs of every project, `<out>/<groupId>.<artifactId>/classes`, as the extension
/// redirects them (`-Dopenidea.build.output=<out>`).
pub(super) fn output_root(cache: &Path, top_dir: &str) -> PathBuf {
    reactor_dir(cache, top_dir).join("out")
}

/// What the recorded model was prepared from.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct PrepareRecord {
    pub fingerprint: LaunchFingerprint,
    pub model: ReactorModel,
}

const MODEL_VERSION: u32 = 1;

/// Files the model depends on: the POM chains, settings, toolchains, the Maven launcher,
/// and generator inputs (any `src/<set>/<dir>` that isn't Java sources or resources:
/// `proto`, `antlr4`, `avro`…), but not the Java sources and resources themselves.
pub(super) fn prepare_fingerprint(
    root: &Path,
    reactor: &[&maven::MavenProject],
    step: &BuildStep,
    local_repo: Option<PathBuf>,
    jar_version: &str,
    cancel: &CancellationToken,
) -> IdeResult<Option<LaunchFingerprint>> {
    let Some(mut inputs) = maven::model_inputs(root, reactor, local_repo) else { return Ok(None) };
    for project in reactor {
        let src = subdir(root, &project.dir).join("src");
        for set in fs::read_dir(&src).into_iter().flatten().flatten() {
            for dir in fs::read_dir(set.path()).into_iter().flatten().flatten() {
                let name = dir.file_name();
                if dir.path().is_dir() && !matches!(name.to_str(), Some("java" | "resources")) {
                    inputs.push(dir.path());
                }
            }
        }
    }
    for dir in step.cwd.ancestors() {
        inputs.extend([dir.join(".mvn"), dir.join("mvnw"), dir.join("mvnw.cmd")]);
        if dir == root {
            break;
        }
    }
    inputs.push(process::program_path(&step.program, &step.env, &step.cwd));
    if let Some(home) = dirs::home_dir() {
        inputs.extend([home.join(".m2/settings.xml"), home.join(".m2/toolchains.xml")]);
    }
    if let Some(home) = step.env.get("JAVA_HOME") {
        inputs.push(Path::new(home).join("release"));
    }
    inputs.sort();
    inputs.dedup();
    let parameters = serde_json::to_string(&(MODEL_VERSION, jar_version, &step.program, &step.args, &step.env))
        .map_err(|e| IdeError::internal(e.to_string()))?;
    Ok(Some(LaunchFingerprint::new(parameters, fingerprint::scan_all(root, inputs, cancel)?)))
}

pub(super) fn load_record(dir: &Path) -> Option<PrepareRecord> {
    let record: PrepareRecord = serde_json::from_slice(&fs::read(dir.join("prepare.json")).ok()?).ok()?;
    (record.model.version == MODEL_VERSION).then_some(record)
}

pub(super) fn save_record(dir: &Path, record: &PrepareRecord) -> IdeResult<()> {
    write_json(&dir.join("prepare.json"), record)
}

pub(super) fn write_json(path: &Path, value: &impl Serialize) -> IdeResult<()> {
    let parent = path.parent().ok_or_else(|| IdeError::internal("no parent folder"))?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(file.as_file_mut(), value).map_err(|e| IdeError::internal(e.to_string()))?;
    file.persist(path).map_err(|e| IdeError::from(e.error))?;
    Ok(())
}

/// Whether the generated source roots the model lists still exist: `mvn clean` removes them.
pub(super) fn generated_roots_exist(model: &ReactorModel) -> bool {
    model.projects.iter().all(|p| {
        [&p.main, &p.test].iter().all(|set| {
            set.source_roots.iter().all(|root| {
                root.exists() || !root.components().any(|c| c.as_os_str() == "target") || is_processor_output(set, root)
            })
        })
    })
}

/// The annotation processors' output folder, which javac writes into and never reads as a root.
pub(super) fn is_processor_output(set: &SourceSet, root: &Path) -> bool {
    set.compiler.as_ref().and_then(|c| c.generated_sources_directory.as_deref()).is_some_and(|dir| dir == root)
}

/// A Maven step at the reactor root running `goals` with the IDE's extension loaded.
pub(super) fn maven_step(
    root: &Path,
    top: &maven::MavenProject,
    jar: &Path,
    output_root: &Path,
    model_file: Option<&Path>,
    extra: &[String],
) -> BuildStep {
    let mut step = maven_build_step(
        &top.command,
        &["-B", "-Dstyle.color=never", maven::LOCAL_REPO_TRACKING_ARG],
        &subdir(root, &top.dir),
    );
    step.args.extend(top.options.iter().cloned());
    step.args.push(format!("-Dmaven.ext.class.path={}", jar.display()));
    step.args.push(format!("-Dopenidea.build.output={}", output_root.display()));
    if let Some(file) = model_file {
        step.args.push(format!("-Dopenidea.build.model={}", file.display()));
    }
    step.args.extend(extra.iter().cloned());
    step.env = top.env.clone();
    step
}

pub(super) fn read_model(path: &Path) -> IdeResult<ReactorModel> {
    let bytes = fs::read(path).map_err(|e| IdeError::internal(format!("Maven wrote no build model ({e})")))?;
    serde_json::from_slice(&bytes).map_err(|e| IdeError::internal(format!("Unreadable build model: {e}")))
}
