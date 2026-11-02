import { call, commands, isTauri } from "@/platform/ipc";
import { openProject } from "@/platform/project";
import type { EmptyForm, GeneratorId, JavaForm, SpringBootForm, ViteForm } from "./types";

const enc = new TextEncoder();

async function writeFile(path: string, content: string): Promise<void> {
  if (isTauri()) {
    await call(commands.fsCreateFileBytes(path, Array.from(enc.encode(content))));
  }
}

async function createDir(path: string): Promise<void> {
  if (isTauri()) {
    await call(commands.fsCreateDir(path)).catch(() => undefined);
  }
}

function resolvePath(location: string, name: string): string {
  const sep = location.includes("/") && !location.includes("\\") ? "/" : "\\";
  const cleanLoc = location.endsWith(sep) ? location.slice(0, -1) : location;
  return `${cleanLoc}${sep}${name}`;
}

export async function executeCreateProject(
  generatorId: GeneratorId,
  state: {
    springBoot: SpringBootForm;
    java: JavaForm;
    empty: EmptyForm;
    vite: ViteForm;
  },
): Promise<string> {
  let targetPath = "";
  let createGit = false;

  if (generatorId === "spring-boot") {
    const f = state.springBoot;
    createGit = f.createGit;
    targetPath = resolvePath(f.location, f.name);
    await createDir(targetPath);

    const isMaven = f.type === "maven";
    const pkgPath = f.packageName.replace(/\./g, "/");
    const srcMainJava = `${targetPath}/src/main/java/${pkgPath}`;
    const srcMainRes = `${targetPath}/src/main/resources`;

    await createDir(`${targetPath}/src`);
    await createDir(`${targetPath}/src/main`);
    await createDir(`${targetPath}/src/main/java`);
    await createDir(srcMainJava);
    await createDir(srcMainRes);

    if (isMaven) {
      const pomXml = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.4.1</version>
        <relativePath/>
    </parent>
    <groupId>${f.group}</groupId>
    <artifactId>${f.artifact}</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>${f.name}</name>
    <description>Demo project for Spring Boot</description>
    <properties>
        <java.version>${f.javaVersion}</java.version>
    </properties>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
`;
      await writeFile(`${targetPath}/pom.xml`, pomXml);
    } else {
      const isKotlinDsl = f.type === "gradle-kotlin";
      const buildGradle = isKotlinDsl
        ? `plugins {
    java
    id("org.springframework.boot") version "3.4.1"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "${f.group}"
version = "0.0.1-SNAPSHOT"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(${f.javaVersion})
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
}
`
        : `plugins {
    id 'java'
    id 'org.springframework.boot' version '3.4.1'
    id 'io.spring.dependency-management' version '1.1.7'
}

group = '${f.group}'
version = '0.0.1-SNAPSHOT'

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(${f.javaVersion})
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter'
    testImplementation 'org.springframework.boot:spring-boot-starter-test'
}
`;
      await writeFile(`${targetPath}/${isKotlinDsl ? "build.gradle.kts" : "build.gradle"}`, buildGradle);
      await writeFile(
        `${targetPath}/${isKotlinDsl ? "settings.gradle.kts" : "settings.gradle"}`,
        `rootProject.name = "${f.name}"\n`,
      );
    }

    const appClass = `${f.name.charAt(0).toUpperCase() + f.name.slice(1).replace(/[^a-zA-Z0-9]/g, "")}Application`;
    const appJava = `package ${f.packageName};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ${appClass} {

    public static void main(String[] args) {
        SpringApplication.run(${appClass}.class, args);
    }

}
`;
    await writeFile(`${srcMainJava}/${appClass}.java`, appJava);

    const configName = f.configuration === "yaml" ? "application.yaml" : "application.properties";
    await writeFile(
      `${srcMainRes}/${configName}`,
      `# Spring Boot Application Configuration\nspring.application.name=${f.name}\n`,
    );

    await writeFile(`${targetPath}/.gitignore`, `target/\nbuild/\n.gradle/\n.idea/\n.openidea/\n*.class\n*.jar\n`);
  } else if (generatorId === "java" || generatorId === "kotlin") {
    const f = state.java;
    createGit = f.createGit;
    targetPath = resolvePath(f.location, f.name);
    await createDir(targetPath);
    await createDir(`${targetPath}/src`);
    await createDir(`${targetPath}/src/main`);
    await createDir(`${targetPath}/src/main/java`);

    if (f.buildSystem === "maven") {
      const pomXml = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <groupId>org.example</groupId>
    <artifactId>${f.name}</artifactId>
    <version>1.0-SNAPSHOT</version>
    <properties>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>
</project>
`;
      await writeFile(`${targetPath}/pom.xml`, pomXml);
    } else {
      await writeFile(
        `${targetPath}/build.gradle`,
        `plugins {\n    id 'java'\n}\n\ngroup = 'org.example'\nversion = '1.0-SNAPSHOT'\n\nrepositories {\n    mavenCentral()\n}\n`,
      );
      await writeFile(`${targetPath}/settings.gradle`, `rootProject.name = '${f.name}'\n`);
    }

    if (f.addSampleCode) {
      if (generatorId === "kotlin") {
        await createDir(`${targetPath}/src/main/kotlin`);
        await writeFile(`${targetPath}/src/main/kotlin/Main.kt`, `fun main() {\n    println("Hello, World!")\n}\n`);
      } else {
        await writeFile(
          `${targetPath}/src/main/java/Main.java`,
          `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}\n`,
        );
      }
    }

    await writeFile(`${targetPath}/.gitignore`, `target/\nbuild/\n.gradle/\n.openidea/\n*.class\n`);
  } else if (generatorId === "empty") {
    const f = state.empty;
    createGit = f.createGit;
    targetPath = resolvePath(f.location, f.name);
    await createDir(targetPath);
    await writeFile(`${targetPath}/.gitignore`, `.openidea/\n`);
  } else if (generatorId === "vite") {
    const f = state.vite;
    createGit = f.createGit;
    targetPath = resolvePath(f.location, f.name);
    await createDir(targetPath);
    await createDir(`${targetPath}/src`);

    const isTs = f.language === "ts";
    const pkgJson = {
      name: f.name,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: isTs ? "tsc && vite build" : "vite build",
        preview: "vite preview",
      },
      dependencies: f.framework === "react" ? { react: "^18.3.1", "react-dom": "^18.3.1" } : {},
      devDependencies: {
        vite: "^5.4.0",
        ...(isTs ? { typescript: "^5.5.0" } : {}),
      },
    };

    await writeFile(`${targetPath}/package.json`, JSON.stringify(pkgJson, null, 2));
    await writeFile(
      `${targetPath}/index.html`,
      `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${f.name}</title>
  </head>
  <body>
    <div id="root"><h1>Hello from ${f.name}!</h1></div>
    <script type="module" src="/src/main.${isTs ? "tsx" : "jsx"}"></script>
  </body>
</html>
`,
    );
    await writeFile(`${targetPath}/src/main.${isTs ? "tsx" : "jsx"}`, `console.log("App initialized");\n`);
    await writeFile(`${targetPath}/.gitignore`, `node_modules/\ndist/\n.openidea/\n`);
  }

  // Initialize git repository if requested
  if (createGit && isTauri()) {
    await call(commands.vcsInit(targetPath)).catch(() => undefined);
  }

  // Open the newly created project in OpenIDEA
  await openProject(targetPath);
  return targetPath;
}
