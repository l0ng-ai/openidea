/**
 * Starter files for File › New Project…. Layouts follow the usual tool for each
 * language (Cargo, Maven, Gradle, PEP 621, Go modules, npm, Composer, the .NET
 * SDK, CMake, Dune, Mix, …) and for each PHP framework's own skeleton, with
 * UTF-8 and a trailing newline.
 */
import { applyOfficialTests } from "./newProjectOfficialTests";
import { extraProjectBuilders } from "./newProjectExtra";
import { webProjectBuilders } from "./newProjectWeb";
import type { StarterChoices } from "./newProjectOptions";
export interface StarterFile {
  /** Relative path. Directories use `/`. */
  path: string;
  contents: string;
}

export interface ProjectNames {
  /** Folder name as entered. */
  raw: string;
  /** Package name: lowercase, hyphens (`my-app`). */
  slug: string;
  /** Import name: lowercase, underscores (`my_app`). */
  snake: string;
  /** Type name (`MyApp`). */
  pascal: string;
}

const RESERVED = new Set([
  "and",
  "as",
  "async",
  "await",
  "break",
  "class",
  "const",
  "continue",
  "crate",
  "def",
  "dyn",
  "else",
  "enum",
  "false",
  "fn",
  "for",
  "from",
  "func",
  "if",
  "impl",
  "import",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "mut",
  "none",
  "not",
  "or",
  "package",
  "pub",
  "return",
  "self",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "use",
  "var",
  "while",
  "yield",
]);

/** Names safe to drop into a package manifest or a source identifier. */
export function projectNames(raw: string): ProjectNames {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let slug = !cleaned || /^[0-9]/.test(cleaned) ? (cleaned ? `app-${cleaned}` : "app") : cleaned;
  if (RESERVED.has(slug)) slug = `${slug}-app`;
  const snake = slug.replace(/-/g, "_");
  const pascal = snake
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return { raw: raw.trim() || slug, slug, snake, pascal: pascal || "App" };
}

function code(body: string): string {
  const lines = body
    .replace(/^\n/, "")
    .replace(/\n[ \t]*$/, "")
    .split("\n");
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const indent = indents.length ? Math.min(...indents) : 0;
  return `${lines.map((line) => line.slice(indent)).join("\n")}\n`;
}

function file(path: string, body: string): StarterFile {
  return { path, contents: code(body) };
}

function ignore(...extra: string[]): StarterFile {
  return file(".gitignore", [".DS_Store", "Thumbs.db", ...extra].join("\n"));
}

type Build = (n: ProjectNames, choices?: StarterChoices) => StarterFile[];

const hello = `println!("Hello, world!");`;

const BUILDERS: Record<string, Build> = {
  rust: (n) => [
    file(
      "Cargo.toml",
      `
      [package]
      name = "${n.slug}"
      version = "0.1.0"
      edition = "2024"

      [dependencies]
    `,
    ),
    file(
      "src/main.rs",
      `
      fn main() {
          ${hello}
      }
    `,
    ),
    ignore("/target/"),
  ],
  java: (n) => [
    file(
      "pom.xml",
      `
      <?xml version="1.0" encoding="UTF-8"?>
      <project xmlns="http://maven.apache.org/POM/4.0.0">
        <modelVersion>4.0.0</modelVersion>
        <groupId>com.example</groupId>
        <artifactId>${n.slug}</artifactId>
        <version>0.1.0</version>
        <properties>
          <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
          <maven.compiler.release>21</maven.compiler.release>
        </properties>
      </project>
    `,
    ),
    file(
      "src/main/java/com/example/Main.java",
      `
      package com.example;

      public final class Main {
          private Main() {}

          public static void main(String[] args) {
              System.out.println("Hello, world!");
          }
      }
    `,
    ),
    ignore("target/"),
  ],
  kotlin: (n) => [
    file("settings.gradle.kts", `rootProject.name = "${n.slug}"`),
    file(
      "build.gradle.kts",
      `
      plugins {
          kotlin("jvm") version "2.1.0"
      }

      repositories {
          mavenCentral()
      }

      kotlin {
          jvmToolchain(21)
      }
    `,
    ),
    file(
      "src/main/kotlin/Main.kt",
      `
      fun main() {
          println("Hello, world!")
      }
    `,
    ),
    ignore(".gradle/", "build/"),
  ],
  scala: (n) => [
    file("project/build.properties", `sbt.version=1.10.7`),
    file(
      "build.sbt",
      `
      ThisBuild / scalaVersion := "3.3.4"
      ThisBuild / organization := "com.example"

      lazy val root = (project in file("."))
        .settings(name := "${n.slug}")
    `,
    ),
    file(
      "src/main/scala/Main.scala",
      `
      @main def entry(): Unit =
        println("Hello, world!")
    `,
    ),
    ignore("target/", ".bsp/"),
  ],
  groovy: (n) => [
    file("settings.gradle", `rootProject.name = '${n.slug}'`),
    file(
      "build.gradle",
      `
      plugins {
          id 'groovy'
      }

      repositories {
          mavenCentral()
      }

      dependencies {
          implementation 'org.apache.groovy:groovy:4.0.24'
      }

      java {
          toolchain {
              languageVersion = JavaLanguageVersion.of(21)
          }
      }
    `,
    ),
    file(
      "src/main/groovy/Main.groovy",
      `
      static void main(String[] args) {
          println 'Hello, world!'
      }
    `,
    ),
    ignore(".gradle/", "build/"),
  ],
  python: (n) => [
    file(
      "pyproject.toml",
      `
      [project]
      name = "${n.slug}"
      version = "0.1.0"
      description = ""
      readme = "README.md"
      requires-python = ">=3.11"

      [project.scripts]
      ${n.snake} = "${n.snake}:main"

      [build-system]
      requires = ["setuptools>=69"]
      build-backend = "setuptools.build_meta"

      [tool.setuptools.packages.find]
      where = ["src"]
    `,
    ),
    file(
      `src/${n.snake}/__init__.py`,
      `
      def main() -> None:
          print("Hello, world!")
    `,
    ),
    file(
      `src/${n.snake}/__main__.py`,
      `
      from ${n.snake} import main

      if __name__ == "__main__":
          main()
    `,
    ),
    file("README.md", `# ${n.pascal}\n`),
    ignore("__pycache__/", "*.py[cod]", ".venv/"),
  ],
  go: (n) => [
    file("go.mod", `module example.com/${n.slug}\n\ngo 1.22`),
    file(
      "main.go",
      `
      package main

      import "fmt"

      func main() {
          fmt.Println("Hello, world!")
      }
    `,
    ),
  ],
  "go.mod": (n) => [
    file("go.mod", `module example.com/${n.slug}\n\ngo 1.22`),
    file(
      "doc.go",
      `
      // Package ${n.snake} is the ${n.slug} module.
      package ${n.snake}
    `,
    ),
  ],
  "go.work": (n) => [
    file("go.work", `go 1.22\n\nuse .`),
    file("go.mod", `module example.com/${n.slug}\n\ngo 1.22`),
    file(
      "doc.go",
      `
      // Package ${n.snake} is the ${n.slug} module.
      package ${n.snake}
    `,
    ),
  ],
  javascript: (n) => [
    file(
      "package.json",
      `
      {
        "name": "${n.slug}",
        "version": "0.1.0",
        "private": true,
        "type": "module",
        "scripts": {
          "start": "node main.js"
        }
      }
    `,
    ),
    file("main.js", `console.log("Hello, world!");`),
    ignore("node_modules/"),
  ],
  typescript: (n) => [
    file(
      "package.json",
      `
      {
        "name": "${n.slug}",
        "version": "0.1.0",
        "private": true,
        "type": "module",
        "scripts": {
          "start": "node --experimental-strip-types src/main.ts",
          "typecheck": "tsc --noEmit"
        },
        "devDependencies": {
          "typescript": "^5.7.0"
        }
      }
    `,
    ),
    file(
      "tsconfig.json",
      `
      {
        "compilerOptions": {
          "target": "ES2022",
          "module": "NodeNext",
          "moduleResolution": "NodeNext",
          "strict": true,
          "noUncheckedIndexedAccess": true,
          "verbatimModuleSyntax": true,
          "rootDir": "src",
          "outDir": "dist",
          "skipLibCheck": true
        },
        "include": ["src"]
      }
    `,
    ),
    file("src/main.ts", `console.log("Hello, world!");`),
    ignore("node_modules/", "dist/"),
  ],
  javascriptreact: (n) => [
    file(
      "package.json",
      `
      {
        "name": "${n.slug}",
        "version": "0.1.0",
        "private": true,
        "type": "module",
        "scripts": {
          "dev": "vite",
          "build": "vite build",
          "preview": "vite preview"
        },
        "dependencies": {
          "react": "^19.0.0",
          "react-dom": "^19.0.0"
        },
        "devDependencies": {
          "@vitejs/plugin-react": "^4.3.4",
          "vite": "^6.0.0"
        }
      }
    `,
    ),
    file(
      "vite.config.js",
      `
      import react from "@vitejs/plugin-react";
      import { defineConfig } from "vite";

      export default defineConfig({
        plugins: [react()],
      });
    `,
    ),
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${escapeHtml(n.raw)}</title>
        </head>
        <body>
          <div id="root"></div>
          <script type="module" src="/src/main.jsx"></script>
        </body>
      </html>
    `,
    ),
    file(
      "src/main.jsx",
      `
      import { StrictMode } from "react";
      import { createRoot } from "react-dom/client";
      import { App } from "./App.jsx";

      createRoot(document.getElementById("root")).render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    `,
    ),
    file(
      "src/App.jsx",
      `
      export function App() {
        return <h1>Hello, world!</h1>;
      }
    `,
    ),
    ignore("node_modules/", "dist/"),
  ],
  typescriptreact: (n) => [
    file(
      "package.json",
      `
      {
        "name": "${n.slug}",
        "version": "0.1.0",
        "private": true,
        "type": "module",
        "scripts": {
          "dev": "vite",
          "build": "tsc --noEmit && vite build",
          "preview": "vite preview"
        },
        "dependencies": {
          "react": "^19.0.0",
          "react-dom": "^19.0.0"
        },
        "devDependencies": {
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
          "@vitejs/plugin-react": "^4.3.4",
          "typescript": "^5.7.0",
          "vite": "^6.0.0"
        }
      }
    `,
    ),
    file(
      "tsconfig.json",
      `
      {
        "compilerOptions": {
          "target": "ES2022",
          "module": "ESNext",
          "moduleResolution": "bundler",
          "jsx": "react-jsx",
          "strict": true,
          "noUncheckedIndexedAccess": true,
          "verbatimModuleSyntax": true,
          "noEmit": true,
          "skipLibCheck": true
        },
        "include": ["src"]
      }
    `,
    ),
    file(
      "vite.config.ts",
      `
      import react from "@vitejs/plugin-react";
      import { defineConfig } from "vite";

      export default defineConfig({
        plugins: [react()],
      });
    `,
    ),
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${escapeHtml(n.raw)}</title>
        </head>
        <body>
          <div id="root"></div>
          <script type="module" src="/src/main.tsx"></script>
        </body>
      </html>
    `,
    ),
    file(
      "src/main.tsx",
      `
      import { StrictMode } from "react";
      import { createRoot } from "react-dom/client";
      import { App } from "./App.tsx";

      const root = document.getElementById("root");
      if (!root) throw new Error("Missing #root");

      createRoot(root).render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    `,
    ),
    file(
      "src/App.tsx",
      `
      export function App() {
        return <h1>Hello, world!</h1>;
      }
    `,
    ),
    ignore("node_modules/", "dist/"),
  ],
  vue: (n) => [
    file(
      "package.json",
      `
      {
        "name": "${n.slug}",
        "version": "0.1.0",
        "private": true,
        "type": "module",
        "scripts": {
          "dev": "vite",
          "build": "vite build",
          "preview": "vite preview"
        },
        "dependencies": {
          "vue": "^3.5.0"
        },
        "devDependencies": {
          "@vitejs/plugin-vue": "^5.2.0",
          "vite": "^6.0.0"
        }
      }
    `,
    ),
    file(
      "vite.config.js",
      `
      import vue from "@vitejs/plugin-vue";
      import { defineConfig } from "vite";

      export default defineConfig({
        plugins: [vue()],
      });
    `,
    ),
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${escapeHtml(n.raw)}</title>
        </head>
        <body>
          <div id="app"></div>
          <script type="module" src="/src/main.js"></script>
        </body>
      </html>
    `,
    ),
    file(
      "src/main.js",
      `
      import { createApp } from "vue";
      import App from "./App.vue";

      createApp(App).mount("#app");
    `,
    ),
    file(
      "src/App.vue",
      `
      <script setup>
      </script>

      <template>
        <h1>Hello, world!</h1>
      </template>
    `,
    ),
    ignore("node_modules/", "dist/"),
  ],
  svelte: (n) => [
    file(
      "package.json",
      `
      {
        "name": "${n.slug}",
        "version": "0.1.0",
        "private": true,
        "type": "module",
        "scripts": {
          "dev": "vite",
          "build": "vite build",
          "preview": "vite preview"
        },
        "devDependencies": {
          "@sveltejs/vite-plugin-svelte": "^5.0.0",
          "svelte": "^5.0.0",
          "vite": "^6.0.0"
        }
      }
    `,
    ),
    file(
      "vite.config.js",
      `
      import { svelte } from "@sveltejs/vite-plugin-svelte";
      import { defineConfig } from "vite";

      export default defineConfig({
        plugins: [svelte()],
      });
    `,
    ),
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${escapeHtml(n.raw)}</title>
        </head>
        <body>
          <div id="app"></div>
          <script type="module" src="/src/main.js"></script>
        </body>
      </html>
    `,
    ),
    file(
      "src/main.js",
      `
      import { mount } from "svelte";
      import App from "./App.svelte";

      mount(App, { target: document.getElementById("app") });
    `,
    ),
    file(
      "src/App.svelte",
      `
      <h1>Hello, world!</h1>
    `,
    ),
    ignore("node_modules/", "dist/"),
  ],
  html: (n) => [
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${escapeHtml(n.raw)}</title>
          <link rel="stylesheet" href="styles.css">
        </head>
        <body>
          <main>
            <h1>${escapeHtml(n.raw)}</h1>
          </main>
        </body>
      </html>
    `,
    ),
    file("styles.css", `body {\n  font-family: sans-serif;\n}`),
  ],
  css: () => [file("styles.css", `body {\n  font-family: sans-serif;\n}`)],
  scss: () => [
    file(
      "styles.scss",
      `
      $font: sans-serif;

      body {
        font-family: $font;
      }
    `,
    ),
  ],
  sass: () => [
    file(
      "styles.sass",
      `
      $font: sans-serif

      body
        font-family: $font
    `,
    ),
  ],
  less: () => [
    file(
      "styles.less",
      `
      @font: sans-serif;

      body {
        font-family: @font;
      }
    `,
    ),
  ],
  php: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "description": "",
        "type": "project",
        "require": {
          "php": ">=8.2"
        },
        "autoload": {
          "psr-4": {
            "Example\\\\": "src/"
          }
        }
      }
    `,
    ),
    file(
      "src/App.php",
      `
      <?php

      declare(strict_types=1);

      namespace Example;

      final class App
      {
          public static function hello(): string
          {
              return 'Hello, world!';
          }
      }
    `,
    ),
    file(
      "public/index.php",
      `
      <?php

      declare(strict_types=1);

      require __DIR__ . '/../vendor/autoload.php';

      echo Example\\App::hello();
    `,
    ),
    ignore("vendor/"),
  ],
  laravel: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "type": "project",
        "description": "",
        "require": {
          "php": "^8.3",
          "laravel/framework": "^13.0",
          "laravel/tinker": "^3.0"
        },
        "require-dev": {
          "laravel/pint": "^1.21",
          "phpunit/phpunit": "^12.0"
        },
        "autoload": {
          "psr-4": {
            "App\\\\": "app/",
            "Database\\\\Factories\\\\": "database/factories/",
            "Database\\\\Seeders\\\\": "database/seeders/"
          }
        },
        "autoload-dev": {
          "psr-4": {
            "Tests\\\\": "tests/"
          }
        },
        "scripts": {
          "post-autoload-dump": [
            "Illuminate\\\\Foundation\\\\ComposerScripts::postAutoloadDump",
            "@php artisan package:discover --ansi"
          ],
          "post-root-package-install": [
            "@php -r \\"file_exists('.env') || copy('.env.example', '.env');\\""
          ],
          "post-create-project-cmd": [
            "@php artisan key:generate --ansi"
          ]
        },
        "extra": {
          "laravel": {
            "dont-discover": []
          }
        },
        "config": {
          "optimize-autoloader": true,
          "preferred-install": "dist",
          "sort-packages": true
        },
        "minimum-stability": "stable",
        "prefer-stable": true
      }
    `,
    ),
    file(
      "artisan",
      `
      #!/usr/bin/env php
      <?php

      use Illuminate\\Foundation\\Application;
      use Symfony\\Component\\Console\\Input\\ArgvInput;

      define('LARAVEL_START', microtime(true));

      require __DIR__.'/vendor/autoload.php';

      /** @var Application $app */
      $app = require_once __DIR__.'/bootstrap/app.php';

      exit($app->handleCommand(new ArgvInput));
    `,
    ),
    file(
      "bootstrap/app.php",
      `
      <?php

      use Illuminate\\Foundation\\Application;
      use Illuminate\\Foundation\\Configuration\\Exceptions;
      use Illuminate\\Foundation\\Configuration\\Middleware;

      return Application::configure(basePath: dirname(__DIR__))
          ->withRouting(
              web: __DIR__.'/../routes/web.php',
              commands: __DIR__.'/../routes/console.php',
              health: '/up',
          )
          ->withMiddleware(function (Middleware $middleware): void {
          })
          ->withExceptions(function (Exceptions $exceptions): void {
          })->create();
    `,
    ),
    file(
      "bootstrap/providers.php",
      `
      <?php

      return [
          App\\Providers\\AppServiceProvider::class,
      ];
    `,
    ),
    file(
      "bootstrap/cache/.gitignore",
      `
      *
      !.gitignore
    `,
    ),
    file(
      "app/Providers/AppServiceProvider.php",
      `
      <?php

      namespace App\\Providers;

      use Illuminate\\Support\\ServiceProvider;

      class AppServiceProvider extends ServiceProvider
      {
          public function register(): void
          {
          }

          public function boot(): void
          {
          }
      }
    `,
    ),
    file(
      "app/Http/Controllers/Controller.php",
      `
      <?php

      namespace App\\Http\\Controllers;

      abstract class Controller
      {
      }
    `,
    ),
    file(
      "routes/web.php",
      `
      <?php

      use Illuminate\\Support\\Facades\\Route;

      Route::get('/', function () {
          return view('welcome');
      });
    `,
    ),
    file(
      "routes/console.php",
      `
      <?php

      use Illuminate\\Support\\Facades\\Artisan;

      Artisan::command('hello', function () {
          $this->info('Hello, world!');
      })->purpose('Print a greeting');
    `,
    ),
    file(
      "resources/views/welcome.blade.php",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>{{ config('app.name') }}</title>
      </head>
      <body>
          <h1>{{ config('app.name') }}</h1>
      </body>
      </html>
    `,
    ),
    file("resources/css/app.css", `body {\n  font-family: sans-serif;\n}`),
    file(
      "resources/js/app.js",
      `
      // Application scripts.
    `,
    ),
    file(
      "vite.config.js",
      `
      import { defineConfig } from 'vite';
      import laravel from 'laravel-vite-plugin';

      export default defineConfig({
          plugins: [
              laravel({
                  input: ['resources/css/app.css', 'resources/js/app.js'],
                  refresh: true,
              }),
          ],
      });
    `,
    ),
    file(
      "package.json",
      `
      {
        "private": true,
        "type": "module",
        "scripts": {
          "dev": "vite",
          "build": "vite build"
        },
        "devDependencies": {
          "laravel-vite-plugin": "^1.2.0",
          "vite": "^6.0.0"
        }
      }
    `,
    ),
    file(
      "config/app.php",
      `
      <?php

      return [
          'name' => env('APP_NAME', '${n.pascal}'),
          'env' => env('APP_ENV', 'production'),
          'debug' => (bool) env('APP_DEBUG', false),
          'url' => env('APP_URL', 'http://localhost'),
          'timezone' => 'UTC',
          'locale' => env('APP_LOCALE', 'en'),
          'fallback_locale' => env('APP_FALLBACK_LOCALE', 'en'),
          'cipher' => 'AES-256-CBC',
          'key' => env('APP_KEY'),
          'maintenance' => [
              'driver' => env('APP_MAINTENANCE_DRIVER', 'file'),
          ],
      ];
    `,
    ),
    file(
      ".env.example",
      `
      APP_NAME="${n.raw.replaceAll('"', "")}"
      APP_ENV=local
      APP_KEY=
      APP_DEBUG=true
      APP_URL=http://localhost

      APP_LOCALE=en
      APP_FALLBACK_LOCALE=en

      DB_CONNECTION=sqlite

      SESSION_DRIVER=file
      CACHE_STORE=file
      QUEUE_CONNECTION=sync
    `,
    ),
    file(
      "tests/TestCase.php",
      `
      <?php

      namespace Tests;

      use Illuminate\\Foundation\\Testing\\TestCase as BaseTestCase;

      abstract class TestCase extends BaseTestCase
      {
      }
    `,
    ),
    file(
      "phpunit.xml",
      `
      <?xml version="1.0" encoding="UTF-8"?>
      <phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xsi:noNamespaceSchemaLocation="vendor/phpunit/phpunit/phpunit.xsd"
               bootstrap="vendor/autoload.php"
               colors="true">
          <testsuites>
              <testsuite name="Unit">
                  <directory>tests</directory>
              </testsuite>
          </testsuites>
          <php>
              <env name="APP_ENV" value="testing"/>
          </php>
      </phpunit>
    `,
    ),
    file("storage/app/.gitkeep", ""),
    file("storage/app/public/.gitkeep", ""),
    file("storage/framework/cache/data/.gitkeep", ""),
    file("storage/framework/sessions/.gitkeep", ""),
    file("storage/framework/views/.gitkeep", ""),
    file("storage/logs/.gitkeep", ""),
    file("database/migrations/.gitkeep", ""),
    ignore("/vendor/", "/node_modules/", ".env", "/public/hot", "/public/storage", "/storage/*.key"),
  ],
  symfony: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "type": "project",
        "description": "",
        "require": {
          "php": ">=8.4",
          "ext-ctype": "*",
          "ext-iconv": "*",
          "symfony/console": "8.1.*",
          "symfony/dotenv": "8.1.*",
          "symfony/flex": "^2.8",
          "symfony/framework-bundle": "8.1.*",
          "symfony/runtime": "8.1.*",
          "symfony/yaml": "8.1.*"
        },
        "autoload": {
          "psr-4": {
            "App\\\\": "src/"
          }
        },
        "autoload-dev": {
          "psr-4": {
            "App\\\\Tests\\\\": "tests/"
          }
        },
        "config": {
          "allow-plugins": {
            "symfony/flex": true,
            "symfony/runtime": true
          },
          "sort-packages": true
        },
        "extra": {
          "symfony": {
            "allow-contrib": false,
            "require": "8.1.*"
          }
        },
        "minimum-stability": "stable",
        "prefer-stable": true
      }
    `,
    ),
    file(
      "public/index.php",
      `
      <?php

      use App\\Kernel;

      require_once dirname(__DIR__).'/vendor/autoload_runtime.php';

      return function (array $context) {
          return new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);
      };
    `,
    ),
    file(
      "bin/console",
      `
      #!/usr/bin/env php
      <?php

      use App\\Kernel;
      use Symfony\\Bundle\\FrameworkBundle\\Console\\Application;

      require_once dirname(__DIR__).'/vendor/autoload_runtime.php';

      return function (array $context) {
          $kernel = new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);

          return new Application($kernel);
      };
    `,
    ),
    file(
      "src/Kernel.php",
      `
      <?php

      declare(strict_types=1);

      namespace App;

      use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;
      use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;

      class Kernel extends BaseKernel
      {
          use MicroKernelTrait;
      }
    `,
    ),
    file(
      "src/Controller/HomeController.php",
      `
      <?php

      declare(strict_types=1);

      namespace App\\Controller;

      use Symfony\\Component\\HttpFoundation\\Response;
      use Symfony\\Component\\Routing\\Attribute\\Route;

      final class HomeController
      {
          #[Route('/', name: 'home')]
          public function index(): Response
          {
              return new Response('Hello, world!');
          }
      }
    `,
    ),
    file(
      "config/bundles.php",
      `
      <?php

      return [
          Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],
      ];
    `,
    ),
    file(
      "config/services.yaml",
      `
      parameters:

      services:
          _defaults:
              autowire: true
              autoconfigure: true

          App\\:
              resource: '../src/'
              exclude:
                  - '../src/Kernel.php'
    `,
    ),
    file(
      "config/routes.yaml",
      `
      controllers:
          resource:
              path: ../src/Controller/
              namespace: App\\Controller
          type: attribute
    `,
    ),
    file(
      "config/packages/framework.yaml",
      `
      framework:
          secret: '%env(APP_SECRET)%'
    `,
    ),
    file(
      ".env",
      `
      APP_ENV=dev
      APP_SECRET=change-me
      APP_DEBUG=1
    `,
    ),
    file("var/cache/.gitkeep", ""),
    file("var/log/.gitkeep", ""),
    ignore("/vendor/", "/var/", "/.env.local", "/.env.*.local"),
  ],
  codeigniter: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "description": "",
        "type": "project",
        "require": {
          "php": "^8.2",
          "codeigniter4/framework": "^4.7"
        },
        "autoload": {
          "psr-4": {
            "App\\\\": "app/",
            "Config\\\\": "app/Config/"
          },
          "exclude-from-classmap": [
            "**/Database/Migrations/**"
          ]
        },
        "config": {
          "optimize-autoloader": true,
          "preferred-install": "dist",
          "sort-packages": true
        }
      }
    `,
    ),
    file(
      "app/Config/Paths.php",
      `
      <?php

      declare(strict_types=1);

      namespace Config;

      class Paths
      {
          public string $systemDirectory = __DIR__ . '/../../vendor/codeigniter4/framework/system';

          public string $appDirectory = __DIR__ . '/..';

          public string $writableDirectory = __DIR__ . '/../../writable';

          public string $testsDirectory = __DIR__ . '/../../tests';

          public string $viewDirectory = __DIR__ . '/../Views';
      }
    `,
    ),
    file(
      "app/Config/Routes.php",
      `
      <?php

      use CodeIgniter\\Router\\RouteCollection;

      /** @var RouteCollection $routes */
      $routes->get('/', 'Home::index');
    `,
    ),
    file(
      "app/Controllers/Home.php",
      `
      <?php

      declare(strict_types=1);

      namespace App\\Controllers;

      use CodeIgniter\\Controller;

      class Home extends Controller
      {
          public function index(): string
          {
              return view('welcome_message', ['title' => '${n.pascal}']);
          }
      }
    `,
    ),
    file(
      "app/Views/welcome_message.php",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <title><?= esc($title) ?></title>
      </head>
      <body>
          <h1><?= esc($title) ?></h1>
      </body>
      </html>
    `,
    ),
    file(
      "public/index.php",
      `
      <?php

      declare(strict_types=1);

      use CodeIgniter\\Boot;
      use Config\\Paths;

      $minPhpVersion = '8.2';
      if (version_compare(PHP_VERSION, $minPhpVersion, '<')) {
          exit(sprintf('PHP %s or higher is required. Current version: %s', $minPhpVersion, PHP_VERSION));
      }

      define('FCPATH', __DIR__ . DIRECTORY_SEPARATOR);
      chdir(FCPATH);

      require FCPATH . '../app/Config/Paths.php';

      $paths = new Paths();
      require $paths->systemDirectory . '/Boot.php';

      exit(Boot::bootWeb($paths));
    `,
    ),
    file(
      "public/.htaccess",
      `
      <IfModule mod_rewrite.c>
          RewriteEngine On
          RewriteCond %{REQUEST_FILENAME} !-f
          RewriteCond %{REQUEST_FILENAME} !-d
          RewriteRule ^ index.php [L]
      </IfModule>
    `,
    ),
    file(
      "spark",
      `
      #!/usr/bin/env php
      <?php

      declare(strict_types=1);

      use CodeIgniter\\Boot;
      use Config\\Paths;

      $minPhpVersion = '8.2';
      if (version_compare(PHP_VERSION, $minPhpVersion, '<')) {
          exit(sprintf('PHP %s or higher is required. Current version: %s', $minPhpVersion, PHP_VERSION));
      }

      define('FCPATH', __DIR__ . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR);
      chdir(FCPATH);

      require FCPATH . '../app/Config/Paths.php';

      $paths = new Paths();
      require $paths->systemDirectory . '/Boot.php';

      exit(Boot::bootSpark($paths));
    `,
    ),
    file(
      "env",
      `
      CI_ENVIRONMENT = development

      app.baseURL = 'http://localhost:8080/'
    `,
    ),
    file("writable/cache/.gitkeep", ""),
    file("writable/logs/.gitkeep", ""),
    file("writable/session/.gitkeep", ""),
    file("writable/uploads/.gitkeep", ""),
    ignore("vendor/", ".env", "writable/cache/*", "writable/logs/*", "writable/session/*", "writable/uploads/*"),
  ],
  cakephp: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "description": "",
        "type": "project",
        "require": {
          "php": ">=8.2",
          "cakephp/cakephp": "5.4.*",
          "cakephp/plugin-installer": "^2.0"
        },
        "autoload": {
          "psr-4": {
            "App\\\\": "src/"
          }
        },
        "autoload-dev": {
          "psr-4": {
            "App\\\\Test\\\\": "tests/"
          }
        },
        "config": {
          "allow-plugins": {
            "cakephp/plugin-installer": true
          },
          "sort-packages": true
        }
      }
    `,
    ),
    file(
      "config/bootstrap.php",
      `
      <?php

      declare(strict_types=1);

      require dirname(__DIR__) . '/vendor/autoload.php';

      use Cake\\Core\\Configure;
      use Cake\\Core\\Configure\\Engine\\PhpConfig;

      Configure::config('default', new PhpConfig(dirname(__DIR__) . '/config/'));
      Configure::load('app', 'default', false);
      date_default_timezone_set(Configure::read('App.defaultTimezone') ?: 'UTC');
    `,
    ),
    file(
      "config/app.php",
      `
      <?php

      declare(strict_types=1);

      return [
          'debug' => filter_var(env('DEBUG', true), FILTER_VALIDATE_BOOLEAN),
          'App' => [
              'namespace' => 'App',
              'encoding' => 'UTF-8',
              'defaultLocale' => 'en_US',
              'defaultTimezone' => 'UTC',
              'base' => false,
              'dir' => 'src',
              'webroot' => 'webroot',
              'wwwRoot' => dirname(__DIR__) . '/webroot/',
              'fullBaseUrl' => false,
              'paths' => [
                  'plugins' => [dirname(__DIR__) . '/plugins/'],
                  'templates' => [dirname(__DIR__) . '/templates/'],
                  'locales' => [dirname(__DIR__) . '/resources/locales/'],
              ],
          ],
          'Security' => [
              'salt' => env('SECURITY_SALT', 'change-me-to-a-random-string'),
          ],
          'Datasources' => [
              'default' => [
                  'className' => 'Cake\\Database\\Connection',
                  'driver' => 'Cake\\Database\\Driver\\Sqlite',
                  'database' => dirname(__DIR__) . '/tmp/app.sqlite',
                  'encoding' => 'utf8',
                  'timezone' => 'UTC',
              ],
          ],
      ];
    `,
    ),
    file(
      "config/routes.php",
      `
      <?php

      declare(strict_types=1);

      use Cake\\Routing\\Route\\DashedRoute;
      use Cake\\Routing\\RouteBuilder;

      return static function (RouteBuilder $routes): void {
          $routes->setRouteClass(DashedRoute::class);
          $routes->scope('/', function (RouteBuilder $builder): void {
              $builder->connect('/', ['controller' => 'Pages', 'action' => 'home']);
              $builder->fallbacks();
          });
      };
    `,
    ),
    file(
      "src/Application.php",
      `
      <?php

      declare(strict_types=1);

      namespace App;

      use Cake\\Http\\BaseApplication;
      use Cake\\Http\\MiddlewareQueue;
      use Cake\\Routing\\Middleware\\RoutingMiddleware;

      class Application extends BaseApplication
      {
          public function middleware(MiddlewareQueue $middlewareQueue): MiddlewareQueue
          {
              return $middlewareQueue->add(new RoutingMiddleware($this));
          }
      }
    `,
    ),
    file(
      "src/Controller/PagesController.php",
      `
      <?php

      declare(strict_types=1);

      namespace App\\Controller;

      use Cake\\Controller\\Controller;

      class PagesController extends Controller
      {
          public function home(): void
          {
              $this->set('title', '${n.pascal}');
          }
      }
    `,
    ),
    file(
      "templates/layout/default.php",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <title><?= h($this->fetch('title')) ?></title>
      </head>
      <body>
          <?= $this->fetch('content') ?>
      </body>
      </html>
    `,
    ),
    file(
      "templates/Pages/home.php",
      `
      <?php
      $this->assign('title', $title ?? '${n.pascal}');
      ?>
      <h1><?= h($title ?? '${n.pascal}') ?></h1>
    `,
    ),
    file(
      "webroot/index.php",
      `
      <?php

      declare(strict_types=1);

      require dirname(__DIR__) . '/config/bootstrap.php';

      use App\\Application;
      use Cake\\Http\\Server;

      $server = new Server(new Application(dirname(__DIR__) . '/config'));
      $server->emit($server->run());
    `,
    ),
    file(
      "bin/cake",
      `
      #!/usr/bin/env php
      <?php

      declare(strict_types=1);

      require dirname(__DIR__) . '/config/bootstrap.php';

      use App\\Application;
      use Cake\\Console\\CommandRunner;

      exit((new CommandRunner(new Application(dirname(__DIR__) . '/config'), 'cake'))->run($argv ?? []));
    `,
    ),
    file("tmp/cache/.gitkeep", ""),
    file("tmp/logs/.gitkeep", ""),
    ignore("vendor/", "tmp/*", "config/app_local.php"),
  ],
  yii: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "description": "",
        "type": "project",
        "require": {
          "php": ">=8.2",
          "yiisoft/yii2": "~2.0.52"
        },
        "autoload": {
          "psr-4": {
            "app\\\\": ""
          }
        },
        "config": {
          "allow-plugins": {
            "yiisoft/yii2-composer": true
          },
          "sort-packages": true
        },
        "scripts": {
          "post-install-cmd": [
            "yii\\\\composer\\\\Installer::postInstall"
          ]
        },
        "extra": {
          "yii\\\\composer\\\\Installer::postInstall": {
            "setPermission": [
              {
                "runtime": "0777",
                "web/assets": "0777"
              }
            ]
          }
        }
      }
    `,
    ),
    file(
      "web/index.php",
      `
      <?php

      require __DIR__ . '/../vendor/autoload.php';
      require __DIR__ . '/../vendor/yiisoft/yii2/Yii.php';

      $config = require __DIR__ . '/../config/web.php';

      (new yii\\web\\Application($config))->run();
    `,
    ),
    file(
      "config/web.php",
      `
      <?php

      return [
          'id' => '${n.slug}',
          'name' => '${n.raw.replaceAll("'", "")}',
          'basePath' => dirname(__DIR__),
          'controllerNamespace' => 'app\\controllers',
          'components' => [
              'request' => [
                  'cookieValidationKey' => 'change-me',
              ],
              'urlManager' => [
                  'enablePrettyUrl' => true,
                  'showScriptName' => false,
              ],
          ],
      ];
    `,
    ),
    file(
      "controllers/SiteController.php",
      `
      <?php

      namespace app\\controllers;

      use yii\\web\\Controller;

      class SiteController extends Controller
      {
          public function actionIndex(): string
          {
              return $this->render('index');
          }
      }
    `,
    ),
    file(
      "views/layouts/main.php",
      `
      <?php
      /** @var yii\\web\\View $this */
      /** @var string $content */
      ?>
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <title><?= htmlspecialchars((string) $this->title, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') ?></title>
      </head>
      <body>
      <?= $content ?>
      </body>
      </html>
    `,
    ),
    file(
      "views/site/index.php",
      `
      <?php
      /** @var yii\\web\\View $this */
      $this->title = '${n.pascal}';
      ?>
      <h1><?= htmlspecialchars((string) $this->title, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') ?></h1>
    `,
    ),
    file("runtime/.gitkeep", ""),
    file("web/assets/.gitkeep", ""),
    ignore("vendor/", "runtime/*", "web/assets/*"),
  ],
  laminas: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "description": "",
        "type": "project",
        "require": {
          "php": ">=8.2",
          "laminas/laminas-mvc": "^3.7"
        },
        "autoload": {
          "psr-4": {
            "Application\\\\": "module/Application/src/"
          }
        },
        "config": {
          "sort-packages": true
        }
      }
    `,
    ),
    file(
      "public/index.php",
      `
      <?php

      declare(strict_types=1);

      use Laminas\\Mvc\\Application;

      chdir(dirname(__DIR__));
      require 'vendor/autoload.php';

      Application::init(require 'config/application.config.php')->run();
    `,
    ),
    file(
      "config/application.config.php",
      `
      <?php

      declare(strict_types=1);

      return [
          'modules' => [
              'Laminas\\Router',
              'Laminas\\Validator',
              'Application',
          ],
          'module_listener_options' => [
              'module_paths' => [
                  './module',
                  './vendor',
              ],
              'config_glob_paths' => [
                  'config/autoload/{{,*.}global,{,*.}local}.php',
              ],
          ],
      ];
    `,
    ),
    file(
      "module/Application/src/Module.php",
      `
      <?php

      declare(strict_types=1);

      namespace Application;

      class Module
      {
          /** @return array<string, mixed> */
          public function getConfig(): array
          {
              return include __DIR__ . '/../config/module.config.php';
          }
      }
    `,
    ),
    file(
      "module/Application/config/module.config.php",
      `
      <?php

      declare(strict_types=1);

      namespace Application;

      use Laminas\\Router\\Http\\Literal;
      use Laminas\\ServiceManager\\Factory\\InvokableFactory;

      return [
          'router' => [
              'routes' => [
                  'home' => [
                      'type' => Literal::class,
                      'options' => [
                          'route' => '/',
                          'defaults' => [
                              'controller' => Controller\\IndexController::class,
                              'action' => 'index',
                          ],
                      ],
                  ],
              ],
          ],
          'controllers' => [
              'factories' => [
                  Controller\\IndexController::class => InvokableFactory::class,
              ],
          ],
          'view_manager' => [
              'template_path_stack' => [
                  __DIR__ . '/../view',
              ],
          ],
      ];
    `,
    ),
    file(
      "module/Application/src/Controller/IndexController.php",
      `
      <?php

      declare(strict_types=1);

      namespace Application\\Controller;

      use Laminas\\Mvc\\Controller\\AbstractActionController;
      use Laminas\\View\\Model\\ViewModel;

      class IndexController extends AbstractActionController
      {
          public function indexAction(): ViewModel
          {
              return new ViewModel(['title' => '${n.pascal}']);
          }
      }
    `,
    ),
    file(
      "module/Application/view/application/index/index.phtml",
      `
      <h1><?= $this->escapeHtml($title) ?></h1>
    `,
    ),
    ignore("vendor/", "data/cache/"),
  ],
  slim: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "description": "",
        "type": "project",
        "require": {
          "php": "^8.2",
          "slim/psr7": "^1.7",
          "slim/slim": "^4.14"
        },
        "autoload": {
          "psr-4": {
            "App\\\\": "src/"
          }
        },
        "config": {
          "sort-packages": true
        }
      }
    `,
    ),
    file(
      "public/index.php",
      `
      <?php

      declare(strict_types=1);

      use Psr\\Http\\Message\\ResponseInterface as Response;
      use Psr\\Http\\Message\\ServerRequestInterface as Request;
      use Slim\\Factory\\AppFactory;

      require __DIR__ . '/../vendor/autoload.php';

      $app = AppFactory::create();
      $app->addErrorMiddleware(true, true, true);
      $app->get('/', function (Request $request, Response $response): Response {
          $response->getBody()->write('Hello, world!');

          return $response;
      });
      $app->run();
    `,
    ),
    ignore("vendor/"),
  ],
  drupal: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "description": "",
        "type": "project",
        "require": {
          "php": ">=8.3",
          "composer/installers": "^2.3",
          "drupal/core-composer-scaffold": "^11.2",
          "drupal/core-project-message": "^11.2",
          "drupal/core-recommended": "^11.2"
        },
        "extra": {
          "drupal-scaffold": {
            "locations": {
              "web-root": "web/"
            }
          },
          "installer-paths": {
            "web/core": ["type:drupal-core"],
            "web/libraries/{$name}": ["type:drupal-library"],
            "web/modules/contrib/{$name}": ["type:drupal-module"],
            "web/profiles/contrib/{$name}": ["type:drupal-profile"],
            "web/themes/contrib/{$name}": ["type:drupal-theme"],
            "drush/Commands/contrib/{$name}": ["type:drupal-drush"]
          }
        },
        "config": {
          "allow-plugins": {
            "composer/installers": true,
            "drupal/core-composer-scaffold": true,
            "drupal/core-project-message": true
          },
          "sort-packages": true
        }
      }
    `,
    ),
    file(
      `web/modules/custom/${n.snake}/${n.snake}.info.yml`,
      `
      name: '${n.pascal}'
      type: module
      description: 'Custom module.'
      core_version_requirement: ^11
      package: Custom
    `,
    ),
    file(
      `web/modules/custom/${n.snake}/${n.snake}.module`,
      `
      <?php

      declare(strict_types=1);

      /**
       * @file
       * Primary module hooks for ${n.snake}.
       */
    `,
    ),
    file(
      `web/modules/custom/${n.snake}/${n.snake}.routing.yml`,
      `
      ${n.snake}.hello:
        path: '/hello'
        defaults:
          _controller: '\\Drupal\\${n.snake}\\Controller\\HelloController::hello'
          _title: '${n.pascal}'
        requirements:
          _permission: 'access content'
    `,
    ),
    file(
      `web/modules/custom/${n.snake}/src/Controller/HelloController.php`,
      `
      <?php

      declare(strict_types=1);

      namespace Drupal\\${n.snake}\\Controller;

      use Drupal\\Core\\Controller\\ControllerBase;

      final class HelloController extends ControllerBase
      {
          /** @return array<string, string> */
          public function hello(): array
          {
              return [
                  '#markup' => (string) $this->t('Hello, world!'),
              ];
          }
      }
    `,
    ),
    ignore("vendor/", "web/core/", "web/modules/contrib/", "web/themes/contrib/", "web/profiles/contrib/"),
  ],
  nette: (n) => [
    file(
      "composer.json",
      `
      {
        "name": "example/${n.slug}",
        "description": "",
        "type": "project",
        "require": {
          "php": ">=8.2",
          "latte/latte": "^3.0",
          "nette/application": "^3.2",
          "nette/bootstrap": "^3.2",
          "tracy/tracy": "^2.10"
        },
        "autoload": {
          "psr-4": {
            "App\\\\": "app/"
          }
        },
        "config": {
          "sort-packages": true
        }
      }
    `,
    ),
    file(
      "www/index.php",
      `
      <?php

      declare(strict_types=1);

      require __DIR__ . '/../vendor/autoload.php';

      $configurator = App\\Bootstrap::boot();
      $configurator->createContainer()
          ->getByType(Nette\\Application\\Application::class)
          ->run();
    `,
    ),
    file(
      "app/Bootstrap.php",
      `
      <?php

      declare(strict_types=1);

      namespace App;

      use Nette\\Bootstrap\\Configurator;

      class Bootstrap
      {
          public static function boot(): Configurator
          {
              $configurator = new Configurator();
              $configurator->setDebugMode(true);
              $configurator->enableTracy(__DIR__ . '/../log');
              $configurator->setTempDirectory(__DIR__ . '/../temp');
              $configurator->addConfig(__DIR__ . '/../config/common.neon');

              return $configurator;
          }
      }
    `,
    ),
    file(
      "config/common.neon",
      `
      application:
          mapping: App\\Presentation\\*\\**Presenter
    `,
    ),
    file(
      "app/Presentation/Home/HomePresenter.php",
      `
      <?php

      declare(strict_types=1);

      namespace App\\Presentation\\Home;

      use Nette\\Application\\UI\\Presenter;

      final class HomePresenter extends Presenter
      {
          public function renderDefault(): void
          {
              $this->template->title = '${n.pascal}';
          }
      }
    `,
    ),
    file(
      "app/Presentation/Home/default.latte",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <title>{$title}</title>
      </head>
      <body>
          <h1>{$title}</h1>
      </body>
      </html>
    `,
    ),
    file("temp/.gitkeep", ""),
    file("log/.gitkeep", ""),
    ignore("vendor/", "temp/*", "log/*"),
  ],
  wordpress: (n) => {
    const title = n.raw.replaceAll("*/", "").replaceAll("\n", " ");
    return [
      file(
        "style.css",
        `
        /*
        Theme Name: ${title}
        Theme URI: https://example.com
        Author: Example
        Description: Block theme.
        Requires at least: 6.7
        Tested up to: 6.8
        Requires PHP: 8.2
        Version: 0.1.0
        License: GPL-2.0-or-later
        Text Domain: ${n.slug}
        */
      `,
      ),
      file(
        "theme.json",
        `
        {
          "$schema": "https://schemas.wp.org/wp/6.7/theme.json",
          "version": 3,
          "settings": {
            "appearanceTools": true,
            "layout": {
              "contentSize": "640px",
              "wideSize": "1100px"
            }
          }
        }
      `,
      ),
      file(
        "templates/index.html",
        `
        <!-- wp:template-part {"slug":"header"} /-->

        <!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} -->
        <main class="wp-block-group">
            <!-- wp:post-content {"layout":{"type":"constrained"}} /-->
        </main>
        <!-- /wp:group -->

        <!-- wp:template-part {"slug":"footer"} /-->
      `,
      ),
      file(
        "parts/header.html",
        `
        <!-- wp:group {"tagName":"header","layout":{"type":"constrained"}} -->
        <header class="wp-block-group">
            <!-- wp:site-title /-->
        </header>
        <!-- /wp:group -->
      `,
      ),
      file(
        "parts/footer.html",
        `
        <!-- wp:group {"tagName":"footer","layout":{"type":"constrained"}} -->
        <footer class="wp-block-group">
            <!-- wp:paragraph -->
            <p></p>
            <!-- /wp:paragraph -->
        </footer>
        <!-- /wp:group -->
      `,
      ),
      file(
        "functions.php",
        `
        <?php

        if (! defined('ABSPATH')) {
            exit;
        }
      `,
      ),
      ignore(),
    ];
  },
  "wordpress-plugin": (n) => {
    const title = n.raw.replaceAll("*/", "").replaceAll("\n", " ");
    return [
      file(
        `${n.slug}.php`,
        `
        <?php
        /**
         * Plugin Name: ${title}
         * Description: A WordPress plugin.
         * Version: 0.1.0
         * Requires at least: 6.7
         * Requires PHP: 8.2
         * License: GPL-2.0-or-later
         * Text Domain: ${n.slug}
         */

        if (! defined('ABSPATH')) {
            exit;
        }
      `,
      ),
      file(
        "readme.txt",
        `
        === ${title} ===
        Contributors: example
        Requires at least: 6.7
        Tested up to: 6.8
        Requires PHP: 8.2
        Stable tag: 0.1.0
        License: GPL-2.0-or-later

        A WordPress plugin.

        == Description ==

        == Installation ==

        1. Upload the plugin directory to \`/wp-content/plugins/\`.
        2. Activate it from the Plugins screen.

        == Changelog ==

        = 0.1.0 =
        * Initial release.
      `,
      ),
      ignore(),
    ];
  },
  c: (n) => [
    file(
      "CMakeLists.txt",
      `
      cmake_minimum_required(VERSION 3.20)
      project(${n.slug} LANGUAGES C)

      set(CMAKE_C_STANDARD 17)
      set(CMAKE_C_STANDARD_REQUIRED ON)

      add_executable(\${PROJECT_NAME} src/main.c)
    `,
    ),
    file(
      "src/main.c",
      `
      #include <stdio.h>

      int main(void) {
          printf("Hello, world!\\n");
          return 0;
      }
    `,
    ),
    ignore("build/"),
  ],
  cpp: (n) => [
    file(
      "CMakeLists.txt",
      `
      cmake_minimum_required(VERSION 3.20)
      project(${n.slug} LANGUAGES CXX)

      set(CMAKE_CXX_STANDARD 17)
      set(CMAKE_CXX_STANDARD_REQUIRED ON)

      add_executable(\${PROJECT_NAME} src/main.cpp)
    `,
    ),
    file(
      "src/main.cpp",
      `
      #include <iostream>

      int main() {
          std::cout << "Hello, world!\\n";
          return 0;
      }
    `,
    ),
    ignore("build/"),
  ],
  csharp: (n) => [
    file(
      `${n.slug}.csproj`,
      `
      <Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup>
          <OutputType>Exe</OutputType>
          <TargetFramework>net8.0</TargetFramework>
          <ImplicitUsings>enable</ImplicitUsings>
          <Nullable>enable</Nullable>
        </PropertyGroup>
      </Project>
    `,
    ),
    file("Program.cs", `Console.WriteLine("Hello, world!");`),
    ignore("bin/", "obj/"),
  ],
  fsharp: (n) => [
    file(
      `${n.slug}.fsproj`,
      `
      <Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup>
          <OutputType>Exe</OutputType>
          <TargetFramework>net8.0</TargetFramework>
        </PropertyGroup>
        <ItemGroup>
          <Compile Include="Program.fs" />
        </ItemGroup>
      </Project>
    `,
    ),
    file(
      "Program.fs",
      `
      [<EntryPoint>]
      let main _ =
          printfn "Hello, world!"
          0
    `,
    ),
    ignore("bin/", "obj/"),
  ],
  swift: (n) => [
    file(
      "Package.swift",
      `
      // swift-tools-version: 5.9
      import PackageDescription

      let package = Package(
          name: "${n.pascal}",
          targets: [
              .executableTarget(name: "${n.pascal}"),
          ]
      )
    `,
    ),
    file(`Sources/${n.pascal}/main.swift`, `print("Hello, world!")`),
    ignore(".build/"),
  ],
  zig: (n) => [
    file(
      "build.zig",
      `
      const std = @import("std");

      pub fn build(b: *std.Build) void {
          const target = b.standardTargetOptions(.{});
          const optimize = b.standardOptimizeOption(.{});
          const exe = b.addExecutable(.{
              .name = "${n.slug}",
              .root_source_file = b.path("src/main.zig"),
              .target = target,
              .optimize = optimize,
          });
          b.installArtifact(exe);
      }
    `,
    ),
    file(
      "src/main.zig",
      `
      const std = @import("std");

      pub fn main() void {
          std.debug.print("Hello, world!\\n", .{});
      }
    `,
    ),
    ignore(".zig-cache/", "zig-out/"),
  ],
  d: (n) => [
    file(
      "dub.json",
      JSON.stringify(
        { authors: [n.slug], description: n.slug, license: "MIT", name: n.slug, targetType: "executable" },
        null,
        2,
      ),
    ),
    file(
      "source/app.d",
      `
      module app;

      import std.stdio;

      void main()
      {
          writeln("${n.slug}");
      }
    `,
    ),
    file(".gitignore", ".dub/\n"),
  ],
  "objective-c": () => [
    file(
      "Makefile",
      `
      .PHONY: all clean

      all: main

      main: main.m
      	$(CC) -fobjc-arc -o main main.m

      clean:
      	rm -f main
    `,
    ),
    file(
      "main.m",
      `
      #import <stdio.h>

      int main(void) {
          printf("Hello, world!\\n");
          return 0;
      }
    `,
    ),
  ],
  "objective-cpp": () => [
    file(
      "Makefile",
      `
      .PHONY: all clean

      all: main

      main: main.mm
      	$(CXX) -fobjc-arc -o main main.mm

      clean:
      	rm -f main
    `,
    ),
    file(
      "main.mm",
      `
      #include <stdio.h>

      int main() {
          printf("Hello, world!\\n");
          return 0;
      }
    `,
    ),
  ],
  shellscript: () => [
    file(
      "main.sh",
      `
      #!/usr/bin/env bash
      set -euo pipefail

      printf 'Hello, world!\\n'
    `,
    ),
  ],
  powershell: () => [
    file(
      "main.ps1",
      `
      #Requires -Version 5.1
      [CmdletBinding()]
      param()

      $ErrorActionPreference = 'Stop'
      Write-Output 'Hello, world!'
    `,
    ),
  ],
  bat: () => [
    file(
      "build.bat",
      `
      @echo off
      setlocal
      echo Hello, world!
      exit /b 0
    `,
    ),
  ],
  ruby: (n) => [
    file("Gemfile", `source "https://rubygems.org"\n\ngemspec`),
    file(
      `${n.slug}.gemspec`,
      `
      Gem::Specification.new do |spec|
        spec.name = "${n.slug}"
        spec.version = "0.1.0"
        spec.summary = "${n.slug}"
        spec.authors = ["Example"]
        spec.required_ruby_version = ">= 3.2"
        spec.files = ["main.rb"]
        spec.bindir = "."
        spec.executables = []
      end
    `,
    ),
    file(
      "main.rb",
      `
      # frozen_string_literal: true

      def main
        puts "Hello, world!"
      end

      main if $PROGRAM_NAME == __FILE__
    `,
    ),
  ],
  perl: () => [
    file(
      "main.pl",
      `
      use v5.36;
      use warnings;

      say "Hello, world!";
    `,
    ),
  ],
  lua: () => [
    file(
      "main.lua",
      `
      local function main()
          print("Hello, world!")
      end

      main()
    `,
    ),
  ],
  r: () => [
    file(
      "main.R",
      `
      main <- function() {
        message("Hello, world!")
      }

      main()
    `,
    ),
  ],
  haskell: (n) => [
    file(
      `${n.slug}.cabal`,
      `
      cabal-version: 3.0
      name: ${n.slug}
      version: 0.1.0.0
      build-type: Simple

      executable ${n.slug}
          main-is: Main.hs
          hs-source-dirs: app
          default-language: Haskell2010
          build-depends: base ^>= 4.17
    `,
    ),
    file(
      "app/Main.hs",
      `
      module Main where

      main :: IO ()
      main = putStrLn "Hello, world!"
    `,
    ),
    ignore("dist-newstyle/"),
  ],
  ocaml: (n) => [
    file("dune-project", `(lang dune 3.16)\n\n(name ${n.snake})\n\n(generate_opam_files true)`),
    file(
      "bin/dune",
      `
      (executable
       (public_name ${n.snake})
       (name main))
    `,
    ),
    file(
      "bin/main.ml",
      `
      let () = print_endline "Hello, world!"
    `,
    ),
    ignore("_build/", "*.opam"),
  ],
  "ocaml.interface": (n) => [
    file("dune-project", `(lang dune 3.16)\n\n(name ${n.snake})`),
    file(
      "lib/dune",
      `
      (library
       (name ${n.snake})
       (public_name ${n.snake}))
    `,
    ),
    file(
      "lib/example.mli",
      `
      (** Greet the caller. *)
      val hello : unit -> string
    `,
    ),
    ignore("_build/"),
  ],
  clojure: () => [
    file(
      "deps.edn",
      `
      {:paths ["src"]
       :deps {org.clojure/clojure {:mvn/version "1.12.0"}}}
    `,
    ),
    file(
      "src/example/core.clj",
      `
      (ns example.core)

      (defn -main
        [& _]
        (println "Hello, world!"))
    `,
    ),
    ignore(".cpcache/"),
  ],
  elixir: (n) => [
    file(
      "mix.exs",
      `
      defmodule ${n.pascal}.MixProject do
        use Mix.Project

        def project do
          [
            app: :${n.snake},
            version: "0.1.0",
            elixir: "~> 1.17",
            start_permanent: Mix.env() == :prod,
            deps: []
          ]
        end

        def application do
          [extra_applications: [:logger]]
        end
      end
    `,
    ),
    file(
      `lib/${n.snake}.ex`,
      `
      defmodule ${n.pascal} do
        def hello do
          "Hello, world!"
        end
      end
    `,
    ),
    ignore("_build/", "deps/"),
  ],
  erlang: (n) => [
    file(
      "rebar.config",
      `
      {erl_opts, [debug_info]}.
      {deps, []}.
    `,
    ),
    file(
      `src/${n.snake}.app.src`,
      `
      {application, ${n.snake},
       [{description, ""},
        {vsn, "0.1.0"},
        {modules, []},
        {registered, []},
        {applications, [kernel, stdlib]}]}.
    `,
    ),
    file(
      `src/${n.snake}.erl`,
      `
      -module(${n.snake}).
      -export([hello/0]).

      hello() ->
          "Hello, world!".
    `,
    ),
    ignore("_build/"),
  ],
  julia: (n) => [
    file(
      "Project.toml",
      `
      name = "${n.pascal}"
      uuid = "${crypto.randomUUID()}"
      version = "0.1.0"
    `,
    ),
    file(
      `src/${n.pascal}.jl`,
      `
      module ${n.pascal}

      function main()
          println("Hello, world!")
      end

      end
    `,
    ),
  ],
  dart: (n) => [
    file(
      "pubspec.yaml",
      `
      name: ${n.snake}
      description: A new Dart project.
      version: 0.1.0
      environment:
        sdk: ^3.5.0
    `,
    ),
    file(
      "bin/main.dart",
      `
      void main(List<String> args) {
        print('Hello, world!');
      }
    `,
    ),
    ignore(".dart_tool/"),
  ],
  nix: (n) => [
    file(
      "flake.nix",
      `
      {
        description = "${n.slug}";

        inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

        outputs = { self, nixpkgs }: {
        };
      }
    `,
    ),
  ],
  gdscript: (n) => [
    file(
      "project.godot",
      `
      ; Engine configuration file.
      config_version=5

      [application]
      config/name="${n.raw.replaceAll('"', "")}"
      run/main_scene="res://main.tscn"
      config/features=PackedStringArray("4.3")
    `,
    ),
    file(
      "main.tscn",
      `
      [gd_scene load_steps=2 format=3]

      [ext_resource type="Script" path="res://main.gd" id="1"]

      [node name="Main" type="Node"]
      script = ExtResource("1")
    `,
    ),
    file(
      "main.gd",
      `
      extends Node

      func _ready() -> void:
          print("Hello, world!")
    `,
    ),
    ignore(".godot/"),
  ],
  gdshader: () => [
    file(
      "main.gdshader",
      `
      shader_type spatial;

      void fragment() {
          ALBEDO = vec3(1.0);
      }
    `,
    ),
  ],
  sql: () => [file("query.sql", `SELECT 1 AS ready;`)],
  json: (n) => [file("data.json", `{\n  "name": "${n.slug}"\n}`)],
  jsonc: (n) => [file("config.jsonc", `{\n  // ${n.slug}\n  "name": "${n.slug}"\n}`)],
  yaml: (n) => [file("data.yaml", `name: ${n.slug}\nversion: "0.1.0"\n`)],
  toml: (n) => [file("config.toml", `name = "${n.slug}"\nversion = "0.1.0"\n`)],
  xml: (n) => [file("data.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<project name="${escapeHtml(n.slug)}"/>\n`)],
  graphql: () => [
    file(
      "schema.graphql",
      `
      type Query {
        hello: String!
      }
    `,
    ),
  ],
  proto: () => [
    file(
      "main.proto",
      `
      syntax = "proto3";

      package example;

      message Hello {
        string name = 1;
      }
    `,
    ),
  ],
  properties: (n) => [file("app.properties", `name=${n.slug}\n`)],
  ini: (n) => [file("config.ini", `[project]\nname=${n.slug}\n`)],
  dockerfile: () => [
    file(
      "Dockerfile",
      `
      FROM debian:stable-slim

      WORKDIR /app

      CMD ["echo", "Hello, world!"]
    `,
    ),
    file(".dockerignore", `.git\n`),
  ],
  cmake: (n) => [
    file(
      "CMakeLists.txt",
      `
      cmake_minimum_required(VERSION 3.20)
      project(${n.slug})
    `,
    ),
  ],
  makefile: () => [
    file(
      "Makefile",
      `
      .PHONY: all

      all:
      	@echo "Hello, world!"
    `,
    ),
  ],
  terraform: () => [
    file(
      "main.tf",
      `
      terraform {
        required_version = ">= 1.6"
      }
    `,
    ),
  ],
  "terraform-vars": () => [
    file(
      "variables.tf",
      `
      variable "name" {
        type        = string
        description = "Project name."
        default     = "app"
      }
    `,
    ),
    file("variables.tfvars", `name = "app"\n`),
  ],
  hcl: (n) => [file("main.hcl", `name = "${n.slug}"\n`)],
  dotenv: () => [
    file(".env.example", `APP_ENV=development\n`),
    file(".env", `APP_ENV=development\n`),
    file(".gitignore", `.env\n!.env.example\n`),
  ],
  http: () => [file("api.http", `GET https://example.com/ HTTP/1.1\n`)],
  markdown: (n) => [file("README.md", `# ${n.pascal}\n\n${n.raw}\n`)],
  asciidoc: (n) => [file("README.adoc", `= ${n.pascal}\n:toc:\n\nHello, world!\n`)],
  latex: (n) => [
    file(
      "main.tex",
      `
      \\documentclass{article}

      \\title{${n.raw.replaceAll("\\", "").replaceAll("%", "")}}
      \\author{}
      \\date{}

      \\begin{document}
      \\maketitle
      \\end{document}
    `,
    ),
  ],
  diff: () => [
    file(
      "changes.diff",
      `
      --- a/README.md
      +++ b/README.md
      @@ -1 +1 @@
      -old
      +new
    `,
    ),
  ],
  log: () => [file("app.log", `2026-01-01T00:00:00Z INFO ready\n`)],
  ignore: () => [ignore("*.log")],
  gitattributes: () => [file(".gitattributes", `* text=auto eol=lf\n`)],
  "godot-resource": (n) => [
    file(
      "project.godot",
      `
      config_version=5

      [application]
      config/name="${n.raw.replaceAll('"', "")}"
      config/features=PackedStringArray("4.3")
    `,
    ),
    file(
      "scene.tscn",
      `
      [gd_scene format=3]

      [node name="Main" type="Node"]
    `,
    ),
  ],
  plaintext: (n) => [file("notes.txt", `${n.raw}\n`)],
  ...extraProjectBuilders,
  ...webProjectBuilders,
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function addSpec(target: Record<string, string>, specs: readonly string[] | undefined) {
  for (const spec of specs ?? []) {
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    target[spec.slice(0, at)] = spec.slice(at + 1);
  }
}

function applyFrameworkChoices(files: StarterFile[], choices?: StarterChoices): StarterFile[] {
  if (!choices) return files;
  return files.map((starter) => {
    if (starter.path !== "composer.json" && starter.path !== "package.json") return starter;
    const json = JSON.parse(starter.contents) as Record<string, unknown>;
    if (starter.path === "composer.json") {
      if (choices.packageName) json.name = choices.packageName;
      const require = (json.require ?? {}) as Record<string, string>;
      const dev = (json["require-dev"] ?? {}) as Record<string, string>;
      addSpec(require, choices.packages);
      addSpec(dev, choices.devPackages);
      if (choices.packages?.length) json.require = require;
      if (choices.devPackages?.length) json["require-dev"] = dev;
    } else if (choices.starterKit === "vue" || choices.starterKit === "react") {
      const deps = (json.dependencies ?? {}) as Record<string, string>;
      const dev = (json.devDependencies ?? {}) as Record<string, string>;
      if (choices.starterKit === "vue") {
        deps.vue = "^3.5.0";
        dev["@vitejs/plugin-vue"] = "^5.2.0";
      } else {
        deps.react = "^19.0.0";
        deps["react-dom"] = "^19.0.0";
        dev["@vitejs/plugin-react"] = "^4.3.0";
      }
      json.dependencies = deps;
      json.devDependencies = dev;
    } else {
      return starter;
    }
    return { path: starter.path, contents: `${JSON.stringify(json, null, 2)}\n` };
  });
}

/** Files to create for a language or framework. An empty project has none. */
export function starterFiles(kindId: string, projectName: string, choices?: StarterChoices): StarterFile[] {
  if (choices?.defaultSetup === false) return [];
  const files = BUILDERS[kindId]?.(projectNames(projectName), choices) ?? [];
  return applyOfficialTests(kindId, projectNames(projectName), applyFrameworkChoices(files, choices));
}
