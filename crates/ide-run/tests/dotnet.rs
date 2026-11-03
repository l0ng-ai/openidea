use ide_run::{
    detect,
    dotnet::{parse_profiles, parse_project, resolve, solution_projects},
};
use std::fs;
use std::path::PathBuf;

const CONSOLE: &str = r#"<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFrameworks>net10.0; net9.0</TargetFrameworks></PropertyGroup></Project>"#;
const PROFILES: &str = r#"{
  // Only Project profiles can be run with dotnet.
  "profiles": {
    "http": {"commandName":"Project", "applicationUrl":"http://localhost:5165", "commandLineArgs":"--message \"hello world\"", "workingDirectory":"work", "environmentVariables":{"DEMO":"profile"}},
    "https": {"commandName":"Project", "environmentVariables":{"DEMO":"https"}},
    "IIS Express": {"commandName":"IISExpress"},
    "external": {"commandName":"Executable"},
    "broken": {"commandName":"Project", "environmentVariables":7}
  }
}"#;

fn write(root: &std::path::Path, file: &str, src: &str) {
    let path = root.join(file);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, src).unwrap();
}

#[test]
fn project_properties_and_sdk_defaults() {
    let p = parse_project(CONSOLE).unwrap();
    assert!(p.executable && !p.test);
    assert_eq!(p.frameworks, ["net10.0", "net9.0"]);
    for (sdk, output, executable) in [
        ("Microsoft.NET.Sdk", "", false),
        ("Microsoft.NET.Sdk", "<OutputType>WinExe</OutputType>", true),
        ("Microsoft.NET.Sdk.Web", "", true),
        ("Microsoft.NET.Sdk.Web", "<OutputType>Library</OutputType>", false),
    ] {
        let xml = format!(
            r#"<Project Sdk="{sdk}"><PropertyGroup>{output}<TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"#
        );
        let p = parse_project(&xml).unwrap();
        assert_eq!(p.executable, executable, "{xml}");
        assert_eq!(p.frameworks, ["net10.0"]);
    }
    let p = parse_project(r#"<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><Sdk Name="Microsoft.NET.Sdk.Web"/><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><PropertyGroup Condition="'$(Configuration)'=='Release'"><OutputType>Library</OutputType></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0" /></ItemGroup></Project>"#).unwrap();
    assert!(p.executable && p.test);
    assert!(parse_project("<Project><PropertyGroup>").is_none());
    assert!(parse_project("garbage").is_none());
    assert!(
        parse_project(
            r#"<Project><ItemGroup><PackageReference Update="microsoft.net.test.sdk" /></ItemGroup></Project>"#
        )
        .unwrap()
        .test
    );
    assert!(
        !parse_project(r#"<Project><!-- <PackageReference Include="Microsoft.NET.Test.Sdk"/> --></Project>"#)
            .unwrap()
            .test
    );
}

#[test]
fn profiles_filter_and_preserve_launch_properties() {
    let p = parse_profiles(PROFILES);
    assert_eq!(p.keys().map(String::as_str).collect::<Vec<_>>(), ["http", "https"]);
    assert_eq!(p["http"].application_url, "http://localhost:5165");
    assert_eq!(p["http"].environment_variables["DEMO"], "profile");
    assert_eq!(p["http"].command_line_args, "--message \"hello world\"");
    assert_eq!(p["http"].working_directory, "work");
    assert!(parse_profiles("invalid").is_empty());
}

#[test]
fn solution_paths_support_windows_separators_folders_and_entities() {
    let sln = "Project(\"{guid}\") = \"App\", \"src\\App\\App.csproj\", \"{guid}\"\nEndProject\nProject(\"{folder}\") = \"Folder\", \"Folder\", \"{guid}\"\nProject(\"{guid}\") = \"External\", \"..\\other\\Other.csproj\", \"{guid}\"";
    assert_eq!(
        solution_projects(sln, false),
        [PathBuf::from("src/App/App.csproj"), PathBuf::from("../other/Other.csproj")]
    );
    let slnx = r#"<Solution><Folder Name="/src/"><Project Path="src\A&amp;B\App.csproj" /></Folder><Project Path="other.vbproj" /></Solution>"#;
    assert_eq!(solution_projects(slnx, true), [PathBuf::from("src/A&B/App.csproj")]);
    assert!(solution_projects("<Solution><Project", true).is_empty());
}

#[test]
fn detection_deduplicates_projects_and_generates_commands() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, "src/App/App.csproj", CONSOLE);
    write(root, "src/App/Properties/launchSettings.json", PROFILES);
    write(
        root,
        "demo.slnx",
        r#"<Solution><Project Path="src/App/App.csproj"/><Project Path="../external/Missing.csproj"/></Solution>"#,
    );
    write(
        root,
        "src/Test/Test.csproj",
        r#"<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk"/></ItemGroup></Project>"#,
    );
    write(root, "bin/Ignored.csproj", CONSOLE);
    write(root, "obj/Ignored.csproj", CONSOLE);
    write(root, "node_modules/Ignored.csproj", CONSOLE);
    write(root, "Lib.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />");
    let configs = detect(root);
    assert_eq!(configs.len(), 4);
    let app = configs.iter().find(|c| c.extras.params.get("launchProfile").is_some_and(|p| p == "http")).unwrap();
    assert_eq!(
        app.args,
        ["run", "--project", "src/App/App.csproj", "--framework", "net10.0", "--launch-profile", "http"]
    );
    assert_eq!(app.debug_adapter.as_deref(), Some("netcoredbg"));
    assert_eq!(app.extras.before_launch[0].kind, "dotnetBuild");
    let test = configs.iter().find(|c| c.is_test).unwrap();
    assert_eq!(test.kind, "dotnet-test");
    assert_eq!(test.args, ["test", "src/Test/Test.csproj", "--framework", "net10.0"]);
    assert!(test.debug_adapter.is_none());
    let mut edited = app.clone();
    edited.env.insert("DEMO".into(), "override".into());
    let resolved = resolve(root, edited.clone()).unwrap();
    assert_eq!(resolved.env["DEMO"], "override");
    assert_eq!(resolved.env["ASPNETCORE_URLS"], "http://localhost:5165");
    assert!(resolved.cwd.unwrap().ends_with("src/App/work"));
    edited.extras.params.insert("launchProfile".into(), "https".into());
    let resolved = resolve(root, edited).unwrap();
    assert!(!resolved.env.contains_key("ASPNETCORE_URLS"));
    assert!(resolved.cwd.unwrap().ends_with("src/App"));
}

#[test]
fn solution_references_can_reach_projects_outside_the_open_directory() {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), "external/App.csproj", CONSOLE);
    write(temp.path(), "open/demo.sln", "Project(\"{guid}\") = \"App\", \"..\\external\\App.csproj\", \"{guid}\"");
    let configs = detect(&temp.path().join("open"));
    assert_eq!(configs.len(), 1);
    assert!(configs[0].args[2].ends_with("external/App.csproj"));
}
