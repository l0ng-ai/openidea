/**
 * Web-framework starters besides the JavaScript generators in
 * `newProjectExtra.ts`. Each layout is the one that language's own tool
 * expects (Django's startproject, a Vite-less Nest app, Spring Boot's Maven
 * parent, Phoenix's endpoint, Flutter's pubspec).
 */
import type { StarterChoices } from "./newProjectOptions";

interface Names {
  slug: string;
  snake: string;
  pascal: string;
}

interface File {
  path: string;
  contents: string;
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

function file(path: string, body: string): File {
  return { path, contents: code(body) };
}

function json(path: string, value: unknown): File {
  return file(path, JSON.stringify(value, null, 2));
}

function npm(
  name: string,
  deps: Record<string, string>,
  dev: Record<string, string>,
  scripts: Record<string, string>,
): File {
  return json("package.json", {
    name,
    private: true,
    version: "0.1.0",
    type: "module",
    scripts,
    dependencies: deps,
    devDependencies: dev,
  });
}

type Build = (n: Names, choices?: StarterChoices) => File[];

const DEV_KEY = "dev-only-change-me-dev-only-change-me-dev-only-change-me";

export const webProjectBuilders: Record<string, Build> = {
  sveltekit: (n) => [
    npm(
      n.slug,
      {},
      {
        "@sveltejs/adapter-auto": "^4.0.0",
        "@sveltejs/kit": "^2.16.0",
        "@sveltejs/vite-plugin-svelte": "^5.0.0",
        svelte: "^5.0.0",
        vite: "^6.0.0",
      },
      { dev: "vite dev", build: "vite build" },
    ),
    file(
      "svelte.config.js",
      `
      import adapter from '@sveltejs/adapter-auto';
      import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

      /** @type {import('@sveltejs/kit').Config} */
      const config = {
        preprocess: vitePreprocess(),
        kit: { adapter: adapter() },
      };

      export default config;
    `,
    ),
    file(
      "vite.config.js",
      `
      import { sveltekit } from '@sveltejs/kit/vite';
      import { defineConfig } from 'vite';

      export default defineConfig({ plugins: [sveltekit()] });
    `,
    ),
    file(
      "src/app.html",
      `
      <!doctype html>
      <html lang="en">
      <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          %sveltekit.head%
      </head>
      <body>
          <div>%sveltekit.body%</div>
      </body>
      </html>
    `,
    ),
    file(
      "src/routes/+page.svelte",
      `
      <h1>${n.pascal}</h1>
    `,
    ),
    file(".gitignore", "node_modules/\n.svelte-kit/\nbuild/\n"),
  ],
  astro: (n) => [
    npm(n.slug, { astro: "^5.0.0" }, {}, { dev: "astro dev", build: "astro build" }),
    file("astro.config.mjs", `import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n`),
    file(
      "src/pages/index.astro",
      `
      ---
      ---
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>${n.pascal}</title>
        </head>
        <body>
          <h1>${n.pascal}</h1>
        </body>
      </html>
    `,
    ),
    file(".gitignore", "node_modules/\ndist/\n.astro/\n"),
  ],
  remix: (n) => [
    json("package.json", {
      name: n.slug,
      private: true,
      type: "module",
      scripts: { dev: "remix vite:dev", build: "remix vite:build" },
      dependencies: {
        "@remix-run/node": "^2.16.0",
        "@remix-run/react": "^2.16.0",
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: { "@remix-run/dev": "^2.16.0", vite: "^6.0.0" },
    }),
    file(
      "vite.config.ts",
      `
      import { vitePlugin as remix } from '@remix-run/dev';
      import { defineConfig } from 'vite';

      export default defineConfig({ plugins: [remix()] });
    `,
    ),
    file(
      "app/root.tsx",
      `
      import { Links, Meta, Outlet, Scripts, ScrollRestoration } from '@remix-run/react';

      export default function App() {
        return (
          <html lang="en">
            <head>
              <meta charSet="utf-8" />
              <Meta />
              <Links />
            </head>
            <body>
              <Outlet />
              <ScrollRestoration />
              <Scripts />
            </body>
          </html>
        );
      }
    `,
    ),
    file(
      "app/routes/_index.tsx",
      `
      export default function Index() {
        return <h1>${n.pascal}</h1>;
      }
    `,
    ),
    file(".gitignore", "node_modules/\nbuild/\n.cache/\n"),
  ],
  nestjs: (n) => [
    json("package.json", {
      name: n.slug,
      private: true,
      scripts: { start: "nest start", "start:dev": "nest start --watch" },
      dependencies: {
        "@nestjs/common": "^11.0.0",
        "@nestjs/core": "^11.0.0",
        "@nestjs/platform-express": "^11.0.0",
        "reflect-metadata": "^0.2.2",
        rxjs: "^7.8.0",
      },
      devDependencies: { "@nestjs/cli": "^11.0.0", typescript: "^5.7.0" },
    }),
    json("nest-cli.json", {
      collection: "@nestjs/schematics",
      sourceRoot: "src",
      compilerOptions: { tsConfigPath: "tsconfig.json" },
    }),
    json("tsconfig.json", {
      compilerOptions: {
        module: "commonjs",
        target: "ES2022",
        outDir: "dist",
        strict: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    }),
    file(
      "src/app.controller.ts",
      `
      import { Controller, Get } from '@nestjs/common';

      @Controller()
      export class AppController {
        @Get()
        home(): string {
          return '${n.pascal}';
        }
      }
    `,
    ),
    file(
      "src/app.module.ts",
      `
      import { Module } from '@nestjs/common';
      import { AppController } from './app.controller';

      @Module({ controllers: [AppController] })
      export class AppModule {}
    `,
    ),
    file(
      "src/main.ts",
      `
      import { NestFactory } from '@nestjs/core';
      import { AppModule } from './app.module';

      async function bootstrap() {
        const app = await NestFactory.create(AppModule);
        await app.listen(3000);
      }

      void bootstrap();
    `,
    ),
    file(".gitignore", "node_modules/\ndist/\n"),
  ],
  fastify: (n) => [
    json("package.json", {
      name: n.slug,
      private: true,
      type: "module",
      scripts: { start: "node index.js" },
      dependencies: { fastify: "^5.2.0" },
    }),
    file(
      "index.js",
      `
      import Fastify from 'fastify';
      import { pathToFileURL } from 'node:url';

      export function build() {
        const app = Fastify();
        app.get('/', async () => ({ app: '${n.slug}' }));
        return app;
      }

      if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
        const app = build();
        await app.listen({ port: 3000, host: '127.0.0.1' });
      }
    `,
    ),
    file(".gitignore", "node_modules/\n"),
  ],
  django: (n) => [
    file("requirements.txt", "Django>=5.1,<6.0\n"),
    file(
      "manage.py",
      `
      #!/usr/bin/env python
      import os
      import sys


      def main():
          os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
          from django.core.management import execute_from_command_line

          execute_from_command_line(sys.argv)


      if __name__ == "__main__":
          main()
    `,
    ),
    file("config/__init__.py", `"""Django project package."""\n`),
    file(
      "config/settings.py",
      `
      SECRET_KEY = "${DEV_KEY}"
      DEBUG = True
      ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
      ROOT_URLCONF = "config.urls"
      INSTALLED_APPS = [
          "django.contrib.contenttypes",
          "django.contrib.staticfiles",
      ]
      MIDDLEWARE = []
      TEMPLATES = [
          {
              "BACKEND": "django.template.backends.django.DjangoTemplates",
              "DIRS": [],
              "APP_DIRS": True,
              "OPTIONS": {"context_processors": []},
          }
      ]
      DATABASES = {
          "default": {
              "ENGINE": "django.db.backends.sqlite3",
              "NAME": "db.sqlite3",
          }
      }
      STATIC_URL = "static/"
      DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
    `,
    ),
    file(
      "config/urls.py",
      `
      from django.http import HttpResponse
      from django.urls import path


      def home(_request):
          return HttpResponse("<h1>${n.pascal}</h1>")


      urlpatterns = [path("", home)]
    `,
    ),
    file(
      "config/wsgi.py",
      `
      import os

      from django.core.wsgi import get_wsgi_application

      os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
      application = get_wsgi_application()
    `,
    ),
    file(
      "config/asgi.py",
      `
      import os

      from django.core.asgi import get_asgi_application

      os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
      application = get_asgi_application()
    `,
    ),
    file(".gitignore", "db.sqlite3\n__pycache__/\n.venv/\n"),
  ],
  flask: (n) => [
    file("requirements.txt", "Flask>=3.1\n"),
    file(
      "app.py",
      `
      from flask import Flask

      app = Flask(__name__)


      @app.get("/")
      def home():
          return "<h1>${n.pascal}</h1>"
    `,
    ),
    file(".gitignore", ".venv/\n__pycache__/\n"),
  ],
  fastapi: (n) => [
    file("requirements.txt", "fastapi>=0.115\nuvicorn>=0.32\n"),
    file(
      "main.py",
      `
      from fastapi import FastAPI

      app = FastAPI()


      @app.get("/")
      def home():
          return {"app": "${n.slug}"}
    `,
    ),
    file(".gitignore", ".venv/\n__pycache__/\n"),
  ],
  rails: (n) => [
    file(
      "Gemfile",
      `
      source "https://rubygems.org"

      gem "rails", "~> 8.0"
      gem "puma", "~> 6.0"
      gem "sqlite3", "~> 2.1"
    `,
    ),
    file(
      "config/boot.rb",
      `
      ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)
      require "bundler/setup"
    `,
    ),
    file(
      "config/application.rb",
      `
      require_relative "boot"
      require "rails"
      require "action_controller/railtie"

      module ${n.pascal}
        class Application < Rails::Application
          config.load_defaults 8.0
          config.api_only = true
          config.eager_load = false
        end
      end
    `,
    ),
    file(
      "config/environment.rb",
      `
      require_relative "application"
      Rails.application.initialize!
    `,
    ),
    file(
      "config/environments/development.rb",
      `
      Rails.application.configure do
        config.enable_reloading = true
        config.eager_load = false
        config.consider_all_requests_local = true
        config.secret_key_base = "${DEV_KEY}"
      end
    `,
    ),
    file("config.ru", `require_relative "config/environment"\nrun Rails.application\n`),
    file(
      "config/routes.rb",
      `
      Rails.application.routes.draw do
        root "pages#home"
      end
    `,
    ),
    file(
      "config/database.yml",
      `
      default: &default
        adapter: sqlite3
        pool: 5

      development:
        <<: *default
        database: storage/development.sqlite3
    `,
    ),
    file(
      "app/controllers/application_controller.rb",
      `
      class ApplicationController < ActionController::API
      end
    `,
    ),
    file(
      "app/controllers/pages_controller.rb",
      `
      class PagesController < ApplicationController
        def home
          render plain: "${n.pascal}"
        end
      end
    `,
    ),
    file(
      "bin/rails",
      `
      #!/usr/bin/env ruby
      APP_PATH = File.expand_path("../config/application", __dir__)
      require_relative "../config/boot"
      require "rails/commands"
    `,
    ),
    file("Rakefile", `require_relative "config/application"\nRails.application.load_tasks\n`),
    file(".gitignore", "/tmp/\n/storage/*.sqlite3\n"),
  ],
  sinatra: (n) => [
    file(
      "Gemfile",
      `
      source "https://rubygems.org"

      gem "puma", "~> 6.0"
      gem "sinatra", "~> 4.1"
      gem "rackup", "~> 2.2"
    `,
    ),
    file(
      "app.rb",
      `
      require "sinatra/base"

      class App < Sinatra::Base
        get "/" do
          "${n.pascal}"
        end
      end
    `,
    ),
    file("config.ru", `require_relative "app"\nrun App\n`),
  ],
  gin: (n) => [
    file("go.mod", `module example.com/${n.slug}\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n`),
    file(
      "main.go",
      `
      package main

      import (
          "net/http"

          "github.com/gin-gonic/gin"
      )

      func newEngine() *gin.Engine {
          router := gin.Default()
          router.GET("/", func(c *gin.Context) {
              c.String(http.StatusOK, "${n.slug}")
          })
          return router
      }

      func main() {
          newEngine().Run(":8080")
      }
    `,
    ),
  ],
  echo: (n) => [
    file("go.mod", `module example.com/${n.slug}\n\ngo 1.22\n\nrequire github.com/labstack/echo/v4 v4.13.3\n`),
    file(
      "main.go",
      `
      package main

      import (
          "net/http"

          "github.com/labstack/echo/v4"
      )

      func newEcho() *echo.Echo {
          e := echo.New()
          e.GET("/", func(c echo.Context) error {
              return c.String(http.StatusOK, "${n.slug}")
          })
          return e
      }

      func main() {
          newEcho().Start(":8080")
      }
    `,
    ),
  ],
  fiber: (n) => [
    file("go.mod", `module example.com/${n.slug}\n\ngo 1.22\n\nrequire github.com/gofiber/fiber/v2 v2.52.6\n`),
    file(
      "main.go",
      `
      package main

      import "github.com/gofiber/fiber/v2"

      func newApp() *fiber.App {
          app := fiber.New()
          app.Get("/", func(c *fiber.Ctx) error {
              return c.SendString("${n.slug}")
          })
          return app
      }

      func main() {
          newApp().Listen(":8080")
      }
    `,
    ),
  ],
  spring: (n) => [
    file(
      "pom.xml",
      `
      <?xml version="1.0" encoding="UTF-8"?>
      <project xmlns="http://maven.apache.org/POM/4.0.0">
        <modelVersion>4.0.0</modelVersion>
        <parent>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-starter-parent</artifactId>
          <version>3.4.1</version>
        </parent>
        <groupId>com.example</groupId>
        <artifactId>${n.slug}</artifactId>
        <version>0.1.0</version>
        <dependencies>
          <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
          </dependency>
        </dependencies>
      </project>
    `,
    ),
    file("src/main/resources/application.properties", "server.port=8080\n"),
    file(
      "src/main/java/com/example/Application.java",
      `
      package com.example;

      import org.springframework.boot.SpringApplication;
      import org.springframework.boot.autoconfigure.SpringBootApplication;
      import org.springframework.web.bind.annotation.GetMapping;
      import org.springframework.web.bind.annotation.RestController;

      @SpringBootApplication
      @RestController
      public class Application {
          public static void main(String[] args) {
              SpringApplication.run(Application.class, args);
          }

          @GetMapping("/")
          public String home() {
              return "${n.pascal}";
          }
      }
    `,
    ),
    file(".gitignore", "target/\n"),
  ],
  ktor: (n) => [
    file("settings.gradle.kts", `rootProject.name = "${n.slug}"\n`),
    file(
      "build.gradle.kts",
      `
      plugins {
          kotlin("jvm") version "2.1.0"
      }

      repositories {
          mavenCentral()
      }

      dependencies {
          implementation("io.ktor:ktor-server-core:3.0.3")
          implementation("io.ktor:ktor-server-netty:3.0.3")
      }

      kotlin {
          jvmToolchain(21)
      }
    `,
    ),
    file(
      "src/main/kotlin/com/example/Application.kt",
      `
      package com.example

      import io.ktor.server.application.Application
      import io.ktor.server.engine.embeddedServer
      import io.ktor.server.netty.Netty
      import io.ktor.server.response.respondText
      import io.ktor.server.routing.get
      import io.ktor.server.routing.routing

      fun main() {
          embeddedServer(Netty, port = 8080, module = Application::module).start(wait = true)
      }

      fun Application.module() {
          routing {
              get("/") {
                  call.respondText("${n.pascal}")
              }
          }
      }
    `,
    ),
    file(".gitignore", ".gradle/\nbuild/\n"),
  ],
  aspnet: (n) => [
    file(
      `${n.slug}.csproj`,
      `
      <Project Sdk="Microsoft.NET.Sdk.Web">
        <PropertyGroup>
          <TargetFramework>net8.0</TargetFramework>
          <Nullable>enable</Nullable>
          <ImplicitUsings>enable</ImplicitUsings>
        </PropertyGroup>
      </Project>
    `,
    ),
    file(
      "Program.cs",
      `
      var builder = WebApplication.CreateBuilder(args);
      var app = builder.Build();

      app.MapGet("/", () => "${n.pascal}");

      app.Run();

      public partial class Program { }
    `,
    ),
    file(".gitignore", "bin/\nobj/\n"),
  ],
  axum: (n) => [
    file(
      "Cargo.toml",
      `
      [package]
      name = "${n.slug}"
      version = "0.1.0"
      edition = "2024"

      [dependencies]
      axum = "0.8"
      tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
      tower = { version = "0.5", features = ["util"] }
    `,
    ),
    file(
      "src/main.rs",
      `
      use axum::{routing::get, Router};

      pub fn app() -> Router {
          Router::new().route("/", get(|| async { "${n.slug}" }))
      }

      #[tokio::main]
      async fn main() {
          let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();
          axum::serve(listener, app()).await.unwrap();
      }

      #[cfg(test)]
      mod tests {
          use super::app;
          use axum::body::Body;
          use axum::http::Request;
          use tower::ServiceExt;

          #[tokio::test]
          async fn home() {
              let response = app()
                  .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
                  .await
                  .unwrap();
              assert_eq!(response.status(), 200);
          }
      }
    `,
    ),
    file(".gitignore", "/target/\n"),
  ],
  phoenix: (n) => [
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
            deps: deps()
          ]
        end

        def application do
          [mod: {${n.pascal}.Application, []}, extra_applications: [:logger]]
        end

        defp deps do
          [
            {:phoenix, "~> 1.7.18"},
            {:bandit, "~> 1.6"},
            {:jason, "~> 1.4"}
          ]
        end
      end
    `,
    ),
    file(
      "config/config.exs",
      `
      import Config

      config :${n.snake}, ${n.pascal}Web.Endpoint,
        http: [ip: {127, 0, 0, 1}, port: 4000],
        server: true,
        secret_key_base: "${DEV_KEY}"

      config :phoenix, :json_library, Jason
    `,
    ),
    file(
      `lib/${n.snake}/application.ex`,
      `
      defmodule ${n.pascal}.Application do
        use Application

        def start(_type, _args) do
          children = [${n.pascal}Web.Endpoint]
          Supervisor.start_link(children, strategy: :one_for_one, name: ${n.pascal}.Supervisor)
        end
      end
    `,
    ),
    file(
      `lib/${n.snake}_web/endpoint.ex`,
      `
      defmodule ${n.pascal}Web.Endpoint do
        use Phoenix.Endpoint, otp_app: :${n.snake}

        plug ${n.pascal}Web.Router
      end
    `,
    ),
    file(
      `lib/${n.snake}_web/router.ex`,
      `
      defmodule ${n.pascal}Web.Router do
        use Phoenix.Router

        get "/", ${n.pascal}Web.PageController, :home
      end
    `,
    ),
    file(
      `lib/${n.snake}_web/controllers/page_controller.ex`,
      `
      defmodule ${n.pascal}Web.PageController do
        use Phoenix.Controller, formats: [:html]

        def home(conn, _params) do
          text(conn, "${n.pascal}")
        end
      end
    `,
    ),
    file(".gitignore", "_build/\ndeps/\n"),
  ],
  flutter: (n) => [
    file(
      "pubspec.yaml",
      `
      name: ${n.snake}
      description: ${n.pascal}
      publish_to: none
      environment:
        sdk: ^3.5.0
      dependencies:
        flutter:
          sdk: flutter
      dev_dependencies:
        flutter_test:
          sdk: flutter
      flutter:
        uses-material-design: true
    `,
    ),
    file(
      "lib/main.dart",
      `
      import 'package:flutter/material.dart';

      void main() {
        runApp(const App());
      }

      class App extends StatelessWidget {
        const App({super.key});

        @override
        Widget build(BuildContext context) {
          return const MaterialApp(
            home: Scaffold(
              body: Center(child: Text('${n.pascal}')),
            ),
          );
        }
      }
    `,
    ),
    file(".gitignore", ".dart_tool/\nbuild/\n"),
  ],
  play: (n) => [
    file("project/build.properties", "sbt.version=1.10.7\n"),
    file("project/plugins.sbt", `addSbtPlugin("org.playframework" % "sbt-plugin" % "3.0.6")\n`),
    file(
      "build.sbt",
      `
      ThisBuild / scalaVersion := "3.3.4"
      ThisBuild / organization := "com.example"

      lazy val root = (project in file("."))
        .enablePlugins(PlayScala)
        .settings(
          name := "${n.slug}",
          libraryDependencies += guice
        )
    `,
    ),
    file("conf/application.conf", `play.http.secret.key = "${DEV_KEY}"\n`),
    file("conf/routes", "GET / controllers.HomeController.index\n"),
    file(
      "app/controllers/HomeController.scala",
      `
      package controllers

      import jakarta.inject._
      import play.api.mvc._

      @Singleton
      class HomeController @Inject() (val controllerComponents: ControllerComponents) extends BaseController {
        def index() = Action {
          Ok("${n.pascal}")
        }
      }
    `,
    ),
    file(".gitignore", "target/\nproject/target/\n"),
  ],
  vapor: (n) => [
    file(
      "Package.swift",
      `
      // swift-tools-version: 5.9
      import PackageDescription

      let package = Package(
          name: "${n.pascal}",
          platforms: [.macOS(.v13)],
          dependencies: [
              .package(url: "https://github.com/vapor/vapor.git", from: "4.102.0"),
          ],
          targets: [
              .executableTarget(
                  name: "${n.pascal}",
                  dependencies: [.product(name: "Vapor", package: "vapor")]
              ),
              .testTarget(
                  name: "${n.pascal}Tests",
                  dependencies: [
                      .target(name: "${n.pascal}"),
                      .product(name: "XCTVapor", package: "vapor"),
                  ]
              ),
          ]
      )
    `,
    ),
    file(
      `Sources/${n.pascal}/main.swift`,
      `
      import Vapor

      @main
      enum Entrypoint {
          static func main() async throws {
              var env = try Environment.detect()
              try LoggingSystem.bootstrap(from: &env)
              let app = Application(env)
              defer { app.shutdown() }
              try configure(app)
              try app.run()
          }
      }
    `,
    ),
    file(
      `Sources/${n.pascal}/configure.swift`,
      `
      import Vapor

      func configure(_ app: Application) throws {
          app.get { _ in "${n.pascal}" }
      }
    `,
    ),
    file(".gitignore", ".build/\n"),
  ],
  ring: (n) => [
    file(
      "deps.edn",
      `
      {:paths ["src"]
       :deps {org.clojure/clojure {:mvn/version "1.12.0"}
              ring/ring-core {:mvn/version "1.12.2"}
              ring/ring-jetty-adapter {:mvn/version "1.12.2"}}}
    `,
    ),
    file(
      `src/${n.snake}/core.clj`,
      `
      (ns ${n.snake}.core
        (:require [ring.adapter.jetty :as jetty]
                  [ring.util.response :as response]))

      (defn handler [_request]
        (response/response "${n.pascal}"))

      (defn -main [& _]
        (jetty/run-jetty handler {:port 3000 :join? true}))
    `,
    ),
    file(".gitignore", ".cpcache/\n"),
  ],
  mojolicious: (n) => [
    file("cpanfile", "requires 'Mojolicious', '>= 9.0';\n"),
    file(
      "app.pl",
      `
      use Mojolicious::Lite;

      get '/' => sub ($c) {
          $c->render(text => '${n.pascal}');
      };

      app->start unless caller;
    `,
    ),
  ],
  cowboy: (n) => [
    file(
      "rebar.config",
      `
      {erl_opts, [debug_info]}.
      {deps, [{cowboy, "2.12.0"}]}.
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
        {applications, [kernel, stdlib, cowboy]},
        {mod, {${n.snake}_app, []}}]}.
    `,
    ),
    file(
      `src/${n.snake}_app.erl`,
      `
      -module(${n.snake}_app).
      -behaviour(application).

      -export([start/2, stop/1]).

      start(_Type, _Args) ->
          Dispatch = cowboy_router:compile([{'_', [{"/", ${n.snake}_handler, []}]}]),
          {ok, _} = cowboy:start_clear(http, [{port, 8080}], #{env => #{dispatch => Dispatch}}),
          ${n.snake}_sup:start_link().

      stop(_State) ->
          ok.
    `,
    ),
    file(
      `src/${n.snake}_sup.erl`,
      `
      -module(${n.snake}_sup).
      -behaviour(supervisor).

      -export([start_link/0, init/1]).

      start_link() ->
          supervisor:start_link({local, ?MODULE}, ?MODULE, []).

      init([]) ->
          {ok, {#{strategy => one_for_one}, []}}.
    `,
    ),
    file(
      `src/${n.snake}_handler.erl`,
      `
      -module(${n.snake}_handler).
      -export([init/2, home_body/0]).

      home_body() ->
          <<"${n.pascal}">>.

      init(Req, State) ->
          Req2 = cowboy_req:reply(200, #{<<"content-type">> => <<"text/plain">>}, home_body(), Req),
          {ok, Req2, State}.

      -ifdef(TEST).
      -include_lib("eunit/include/eunit.hrl").

      home_test() ->
          ?assertEqual(<<"${n.pascal}">>, home_body()).
      -endif.
    `,
    ),
  ],
  giraffe: (n) => [
    file(
      `${n.slug}.fsproj`,
      `
      <Project Sdk="Microsoft.NET.Sdk.Web">
        <PropertyGroup>
          <TargetFramework>net8.0</TargetFramework>
        </PropertyGroup>
        <ItemGroup>
          <Compile Include="Program.fs" />
          <PackageReference Include="Giraffe" Version="7.0.0" />
          <InternalsVisibleTo Include="${n.slug}.Tests" />
        </ItemGroup>
      </Project>
    `,
    ),
    file(
      "Program.fs",
      `
      open Giraffe
      open Microsoft.AspNetCore.Builder

      let webApp = route "/" >=> text "${n.pascal}"

      let app = WebApplication.CreateBuilder().Build()
      app.UseGiraffe(webApp)
      app.Run()
    `,
    ),
    file(".gitignore", "bin/\nobj/\n"),
  ],
};
