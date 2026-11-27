/** Gradle scripts and static inputs whose edits can change the build model or libraries. */
export function isGradleBuildInput(path: string): boolean {
  return /(?:^|[\\/])(?:[^\\/]+\.gradle(?:\.kts)?|gradle\.properties|gradle-wrapper\.properties|[^\\/]+\.versions\.toml)$/.test(
    path,
  );
}

/** A project POM or a POM installed in the local Maven repository. */
export function isMavenPom(path: string): boolean {
  return /(^|[\\/])(?:pom\.xml|[^\\/]+\.pom)$/i.test(path);
}
