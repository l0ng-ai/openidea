/**
 * Test files that follow each framework's own starter guide: the spec Nest
 * generates, Playwright for Next.js, `@nuxt/test-utils`, Vite's React and Vue
 * Testing Library setup, Spring's `@SpringBootTest`, Ktor's `testApplication`,
 * Flutter's `testWidgets`, and the matching runner for the other frameworks.
 */
export interface StarterFile {
  path: string;
  contents: string;
}

export interface OfficialCase {
  path: string;
  /** API named by that framework's testing guide. */
  marker: string;
}

interface Names {
  slug: string;
  snake: string;
  pascal: string;
}

function text(body: string): string {
  const lines = body
    .replace(/^\n/, "")
    .replace(/\n[ \t]*$/, "")
    .split("\n");
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const indent = indents.length ? Math.min(...indents) : 0;
  return `${lines.map((line) => line.slice(indent)).join("\n")}\n`;
}

function file(path: string, body: string): StarterFile {
  return { path, contents: text(body) };
}

function replacePath(files: readonly StarterFile[], path: string, contents: string): StarterFile[] {
  return files.map((starter) => (starter.path === path ? { path, contents } : starter));
}

function addNpm(
  files: readonly StarterFile[],
  scripts: Record<string, string>,
  dev: Record<string, string>,
): StarterFile[] {
  return files.map((starter) => {
    if (starter.path !== "package.json") return starter;
    const pkg = JSON.parse(starter.contents) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    pkg.scripts = { ...pkg.scripts, ...scripts };
    pkg.devDependencies = { ...pkg.devDependencies, ...dev };
    return { path: starter.path, contents: `${JSON.stringify(pkg, null, 2)}\n` };
  });
}

function append(files: readonly StarterFile[], path: string, extra: string): StarterFile[] {
  return files.map((starter) =>
    starter.path === path
      ? {
          path,
          contents: starter.contents.endsWith("\n") ? `${starter.contents}${extra}` : `${starter.contents}\n${extra}`,
        }
      : starter,
  );
}

/** The test file for `kindId`, or null when that row is a language starter. */
export function officialCase(kindId: string, names: Names): OfficialCase | null {
  const cases: Record<string, OfficialCase> = {
    nextjs: { path: "e2e/home.spec.ts", marker: "@playwright/test" },
    nuxt: { path: "test/nuxt/app.test.ts", marker: "mountSuspended" },
    react: { path: "src/App.test.tsx", marker: "@testing-library/react" },
    vuejs: { path: "src/App.spec.ts", marker: "@vue/test-utils" },
    angular: { path: "src/app.spec.ts", marker: "TestBed" },
    sveltekit: { path: "src/routes/page.spec.ts", marker: "@testing-library/svelte" },
    astro: { path: "e2e/home.spec.ts", marker: "@playwright/test" },
    remix: { path: "app/routes/index.spec.tsx", marker: "@testing-library/react" },
    express: { path: "test/app.test.js", marker: "node:test" },
    nestjs: { path: "src/app.controller.spec.ts", marker: "@nestjs/testing" },
    fastify: { path: "test/app.test.js", marker: "inject" },
    vite: { path: "src/main.test.js", marker: "jsdom" },
    node: { path: "test/hello.test.js", marker: "node:test" },
    "react-native": { path: "__tests__/App.test.tsx", marker: "react-test-renderer" },
    bootstrap: { path: "test/home.test.js", marker: "node:test" },
    "html5-boilerplate": { path: "test/home.test.js", marker: "node:test" },
    django: { path: "tests/test_home.py", marker: "django.test" },
    flask: { path: "tests/test_app.py", marker: "test_client" },
    fastapi: { path: "test_main.py", marker: "TestClient" },
    rails: { path: "test/controllers/pages_controller_test.rb", marker: "ActionDispatch::IntegrationTest" },
    sinatra: { path: "test/app_test.rb", marker: "Rack::Test" },
    gin: { path: "main_test.go", marker: "httptest" },
    echo: { path: "main_test.go", marker: "httptest" },
    fiber: { path: "main_test.go", marker: "newApp().Test" },
    spring: { path: "src/test/java/com/example/ApplicationTests.java", marker: "@SpringBootTest" },
    ktor: { path: "src/test/kotlin/com/example/ApplicationTest.kt", marker: "testApplication" },
    aspnet: { path: "tests/HomeTests.cs", marker: "WebApplicationFactory" },
    axum: { path: "src/main.rs", marker: "oneshot" },
    phoenix: { path: `test/${names.snake}_web/controllers/page_controller_test.exs`, marker: "text_response" },
    flutter: { path: "test/widget_test.dart", marker: "testWidgets" },
    play: { path: "test/controllers/HomeControllerSpec.scala", marker: "FakeRequest" },
    vapor: { path: `Tests/${names.pascal}Tests/AppTests.swift`, marker: "XCTVapor" },
    ring: { path: `test/${names.snake}/core_test.clj`, marker: "clojure.test" },
    mojolicious: { path: "t/app.t", marker: "Test::Mojo" },
    cowboy: { path: `src/${names.snake}_handler.erl`, marker: "home_test" },
    giraffe: { path: "tests/HomeTests.fs", marker: "WebApplicationFactory" },
    laravel: { path: "tests/Feature/HomeTest.php", marker: "assertOk" },
    symfony: { path: "tests/Controller/HomeControllerTest.php", marker: "WebTestCase" },
  };
  return cases[kindId] ?? null;
}

function extras(kindId: string, names: Names): StarterFile[] {
  const name = names.pascal;
  const slug = names.slug;
  switch (kindId) {
    case "nextjs":
      return [
        file(
          "playwright.config.ts",
          `
          import { defineConfig } from '@playwright/test';

          export default defineConfig({
            testDir: 'e2e',
            use: { baseURL: 'http://127.0.0.1:3000' },
            webServer: { command: 'npm run dev', url: 'http://127.0.0.1:3000', reuseExistingServer: true },
          });
        `,
        ),
        file(
          "e2e/home.spec.ts",
          `
          import { expect, test } from '@playwright/test';

          test('home page shows the project name', async ({ page }) => {
            await page.goto('/');
            await expect(page.getByRole('heading')).toHaveText('${name}');
          });
        `,
        ),
      ];
    case "nuxt":
      return [
        file(
          "vitest.config.ts",
          `
          import { defineVitestConfig } from '@nuxt/test-utils/config';

          export default defineVitestConfig({
            test: { environment: 'nuxt' },
          });
        `,
        ),
        file(
          "test/nuxt/app.test.ts",
          `
          import { mountSuspended } from '@nuxt/test-utils/runtime';
          import { describe, expect, it } from 'vitest';
          import App from '../../app/app.vue';

          describe('App', () => {
            it('renders the project name', async () => {
              const wrapper = await mountSuspended(App);
              expect(wrapper.text()).toContain('${name}');
            });
          });
        `,
        ),
      ];
    case "react":
      return [
        file(
          "vitest.config.ts",
          `
          import react from '@vitejs/plugin-react';
          import { defineConfig } from 'vitest/config';

          export default defineConfig({
            plugins: [react()],
            test: { environment: 'jsdom' },
          });
        `,
        ),
        file(
          "src/App.test.tsx",
          `
          import { render, screen } from '@testing-library/react';
          import { describe, expect, it } from 'vitest';
          import { App } from './App';

          describe('App', () => {
            it('renders the project name', () => {
              render(<App />);
              expect(screen.getByRole('heading').textContent).toBe('${name}');
            });
          });
        `,
        ),
      ];
    case "vuejs":
      return [
        file(
          "vitest.config.ts",
          `
          import vue from '@vitejs/plugin-vue';
          import { defineConfig } from 'vitest/config';

          export default defineConfig({
            plugins: [vue()],
            test: { environment: 'jsdom' },
          });
        `,
        ),
        file(
          "src/App.spec.ts",
          `
          import { mount } from '@vue/test-utils';
          import { describe, expect, it } from 'vitest';
          import App from './App.vue';

          describe('App', () => {
            it('renders the project name', () => {
              expect(mount(App).text()).toContain('${name}');
            });
          });
        `,
        ),
      ];
    case "angular":
      return [
        file(
          "src/app.spec.ts",
          `
          import { TestBed } from '@angular/core/testing';
          import { App } from './app';

          describe('App', () => {
            beforeEach(async () => {
              await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
            });

            it('shows the project name', () => {
              const fixture = TestBed.createComponent(App);
              fixture.detectChanges();
              expect(fixture.nativeElement.textContent).toContain('${name}');
            });
          });
        `,
        ),
      ];
    case "sveltekit":
      return [
        file(
          "src/routes/page.spec.ts",
          `
          import { render } from '@testing-library/svelte';
          import { describe, expect, it } from 'vitest';
          import Page from './+page.svelte';

          describe('Page', () => {
            it('renders the project name', () => {
              expect(render(Page).container.textContent).toContain('${name}');
            });
          });
        `,
        ),
      ];
    case "astro":
      return [
        file(
          "playwright.config.ts",
          `
          import { defineConfig } from '@playwright/test';

          export default defineConfig({
            testDir: 'e2e',
            use: { baseURL: 'http://127.0.0.1:4321' },
            webServer: { command: 'npm run dev', url: 'http://127.0.0.1:4321', reuseExistingServer: true },
          });
        `,
        ),
        file(
          "e2e/home.spec.ts",
          `
          import { expect, test } from '@playwright/test';

          test('home page shows the project name', async ({ page }) => {
            await page.goto('/');
            await expect(page.getByRole('heading')).toHaveText('${name}');
          });
        `,
        ),
      ];
    case "remix":
      return [
        file(
          "app/routes/index.spec.tsx",
          `
          import { render, screen } from '@testing-library/react';
          import { describe, expect, it } from 'vitest';
          import Index from './_index';

          describe('Index', () => {
            it('renders the project name', () => {
              render(<Index />);
              expect(screen.getByRole('heading').textContent).toBe('${name}');
            });
          });
        `,
        ),
      ];
    case "express":
      return [
        file(
          "test/app.test.js",
          `
          import assert from 'node:assert/strict';
          import test from 'node:test';
          import { app } from '../index.js';

          test('home page shows the project name', async () => {
            const server = app.listen(0);
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            const response = await fetch('http://127.0.0.1:' + port + '/');
            assert.equal(response.status, 200);
            assert.match(await response.text(), /${name}/);
            server.close();
          });
        `,
        ),
      ];
    case "nestjs":
      return [
        file(
          "src/app.controller.spec.ts",
          `
          import { Test } from '@nestjs/testing';
          import { describe, expect, it } from 'vitest';
          import { AppController } from './app.controller';

          describe('AppController', () => {
            it('returns the project name', async () => {
              const module = await Test.createTestingModule({ controllers: [AppController] }).compile();
              expect(module.get(AppController).home()).toBe('${name}');
            });
          });
        `,
        ),
      ];
    case "fastify":
      return [
        file(
          "test/app.test.js",
          `
          import assert from 'node:assert/strict';
          import test from 'node:test';
          import { build } from '../index.js';

          test('home route returns the project slug', async () => {
            const app = build();
            const response = await app.inject({ method: 'GET', url: '/' });
            assert.equal(response.statusCode, 200);
            assert.equal(response.json().app, '${slug}');
            await app.close();
          });
        `,
        ),
      ];
    case "vite":
      return [
        file(
          "src/main.test.js",
          `
          // @vitest-environment jsdom
          import { expect, it } from 'vitest';

          it('writes the project name into the page', async () => {
            document.body.innerHTML = '<div id="app"></div>';
            await import('./main.js');
            expect(document.querySelector('#app')?.textContent).toBe('${name}');
          });
        `,
        ),
      ];
    case "node":
      return [
        file(
          "test/hello.test.js",
          `
          import assert from 'node:assert/strict';
          import test from 'node:test';
          import { greeting } from '../index.js';

          test('greeting follows the Node starter', () => {
            assert.equal(greeting(), 'Hello, world!');
          });
        `,
        ),
      ];
    case "react-native":
      return [
        file(
          "__tests__/App.test.tsx",
          `
          import renderer from 'react-test-renderer';
          import App from '../App';

          test('renders the project name', () => {
            const tree = renderer.create(<App />).toJSON();
            expect(JSON.stringify(tree)).toContain('${name}');
          });
        `,
        ),
      ];
    case "bootstrap":
    case "html5-boilerplate":
      return [
        file(
          "test/home.test.js",
          `
          import assert from 'node:assert/strict';
          import { readFile } from 'node:fs/promises';
          import test from 'node:test';

          test('home page shows the project name', async () => {
            const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
            assert.match(html, /<h1>${name}<\\/h1>/);
          });
        `,
        ),
      ];
    case "django":
      return [
        file(
          "tests/test_home.py",
          `
          import os

          os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

          import django
          from django.test import Client

          django.setup()


          def test_home():
              response = Client().get("/")
              assert response.status_code == 200
              assert b"${name}" in response.content
        `,
        ),
      ];
    case "flask":
      return [
        file(
          "tests/test_app.py",
          `
          from app import app


          def test_home():
              response = app.test_client().get("/")
              assert response.status_code == 200
              assert b"${name}" in response.data
        `,
        ),
      ];
    case "fastapi":
      return [
        file(
          "test_main.py",
          `
          from fastapi.testclient import TestClient
          from main import app

          client = TestClient(app)


          def test_home():
              response = client.get("/")
              assert response.status_code == 200
              assert response.json() == {"app": "${slug}"}
        `,
        ),
      ];
    case "rails":
      return [
        file(
          "config/environments/test.rb",
          `
          Rails.application.configure do
            config.enable_reloading = false
            config.eager_load = false
            config.consider_all_requests_local = true
            config.secret_key_base = "dev-only-change-me-dev-only-change-me-dev-only-change"
          end
        `,
        ),
        file(
          "test/test_helper.rb",
          `
          ENV["RAILS_ENV"] ||= "test"
          require_relative "../config/environment"
          require "rails/test_help"
        `,
        ),
        file(
          "test/controllers/pages_controller_test.rb",
          `
          require "test_helper"

          class PagesControllerTest < ActionDispatch::IntegrationTest
            test "home shows the project name" do
              get root_path
              assert_response :success
              assert_match "${name}", response.body
            end
          end
        `,
        ),
      ];
    case "sinatra":
      return [
        file(
          "test/app_test.rb",
          `
          require "minitest/autorun"
          require "rack/test"
          require_relative "../app"

          class AppTest < Minitest::Test
            include Rack::Test::Methods

            def app
              App
            end

            def test_home
              get "/"
              assert last_response.ok?
              assert_includes last_response.body, "${name}"
            end
          end
        `,
        ),
      ];
    case "gin":
      return [
        file(
          "main_test.go",
          `
          package main

          import (
              "net/http"
              "net/http/httptest"
              "testing"
          )

          func TestHome(t *testing.T) {
              recorder := httptest.NewRecorder()
              request, err := http.NewRequest(http.MethodGet, "/", nil)
              if err != nil {
                  t.Fatal(err)
              }
              newEngine().ServeHTTP(recorder, request)
              if recorder.Code != http.StatusOK {
                  t.Fatalf("status %d", recorder.Code)
              }
              if recorder.Body.String() != "${slug}" {
                  t.Fatalf("body %s", recorder.Body.String())
              }
          }
        `,
        ),
      ];
    case "echo":
      return [
        file(
          "main_test.go",
          `
          package main

          import (
              "net/http"
              "net/http/httptest"
              "testing"
          )

          func TestHome(t *testing.T) {
              request := httptest.NewRequest(http.MethodGet, "/", nil)
              recorder := httptest.NewRecorder()
              newEcho().ServeHTTP(recorder, request)
              if recorder.Code != http.StatusOK {
                  t.Fatalf("status %d", recorder.Code)
              }
              if recorder.Body.String() != "${slug}" {
                  t.Fatalf("body %s", recorder.Body.String())
              }
          }
        `,
        ),
      ];
    case "fiber":
      return [
        file(
          "main_test.go",
          `
          package main

          import (
              "io"
              "net/http"
              "testing"
          )

          func TestHome(t *testing.T) {
              request, err := http.NewRequest(http.MethodGet, "/", nil)
              if err != nil {
                  t.Fatal(err)
              }
              response, err := newApp().Test(request)
              if err != nil {
                  t.Fatal(err)
              }
              body, err := io.ReadAll(response.Body)
              if err != nil {
                  t.Fatal(err)
              }
              if string(body) != "${slug}" {
                  t.Fatalf("body %s", body)
              }
          }
        `,
        ),
      ];
    case "spring":
      return [
        file(
          "src/test/java/com/example/ApplicationTests.java",
          `
          package com.example;

          import org.junit.jupiter.api.Test;
          import org.springframework.beans.factory.annotation.Autowired;
          import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
          import org.springframework.boot.test.context.SpringBootTest;
          import org.springframework.test.web.servlet.MockMvc;

          import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
          import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
          import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

          @SpringBootTest
          @AutoConfigureMockMvc
          class ApplicationTests {
              @Autowired
              private MockMvc mvc;

              @Test
              void home() throws Exception {
                  mvc.perform(get("/")).andExpect(status().isOk()).andExpect(content().string("${name}"));
              }
          }
        `,
        ),
      ];
    case "ktor":
      return [
        file(
          "src/test/kotlin/com/example/ApplicationTest.kt",
          `
          package com.example

          import io.ktor.client.request.get
          import io.ktor.client.statement.bodyAsText
          import io.ktor.http.HttpStatusCode
          import io.ktor.server.testing.testApplication
          import kotlin.test.Test
          import kotlin.test.assertEquals

          class ApplicationTest {
              @Test
              fun home() = testApplication {
                  application { module() }
                  val response = client.get("/")
                  assertEquals(HttpStatusCode.OK, response.status)
                  assertEquals("${name}", response.bodyAsText())
              }
          }
        `,
        ),
      ];
    case "aspnet":
      return [
        file(
          `tests/${slug}.Tests.csproj`,
          `
          <Project Sdk="Microsoft.NET.Sdk">
            <PropertyGroup>
              <TargetFramework>net8.0</TargetFramework>
              <ImplicitUsings>enable</ImplicitUsings>
              <Nullable>enable</Nullable>
              <IsPackable>false</IsPackable>
            </PropertyGroup>
            <ItemGroup>
              <ProjectReference Include="../${slug}.csproj" />
              <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="8.0.11" />
              <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
              <PackageReference Include="xunit" Version="2.9.2" />
              <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
            </ItemGroup>
          </Project>
        `,
        ),
        file(
          "tests/HomeTests.cs",
          `
          using Microsoft.AspNetCore.Mvc.Testing;

          public class HomeTests : IClassFixture<WebApplicationFactory<Program>> {
              private readonly WebApplicationFactory<Program> factory;

              public HomeTests(WebApplicationFactory<Program> factory) => this.factory = factory;

              [Fact]
              public async Task HomeReturnsTheProjectName() {
                  var client = factory.CreateClient();
                  var body = await client.GetStringAsync("/");
                  Assert.Equal("${name}", body);
              }
          }
        `,
        ),
      ];
    case "phoenix":
      return [
        file(
          "test/test_helper.exs",
          `
          ExUnit.start()
          {:ok, _} = Application.ensure_all_started(:${names.snake})
        `,
        ),
        file(
          `test/${names.snake}_web/controllers/page_controller_test.exs`,
          `
          defmodule ${name}Web.PageControllerTest do
            use ExUnit.Case, async: true
            import Phoenix.ConnTest

            @endpoint ${name}Web.Endpoint

            test "GET / shows the project name" do
              conn = get(build_conn(), "/")
              assert text_response(conn, 200) =~ "${name}"
            end
          end
        `,
        ),
      ];
    case "flutter":
      return [
        file(
          "test/widget_test.dart",
          `
          import 'package:flutter_test/flutter_test.dart';
          import 'package:${names.snake}/main.dart';

          void main() {
            testWidgets('shows the project name', (tester) async {
              await tester.pumpWidget(const App());
              expect(find.text('${name}'), findsOneWidget);
            });
          }
        `,
        ),
      ];
    case "play":
      return [
        file(
          "test/controllers/HomeControllerSpec.scala",
          `
          package controllers

          import org.scalatestplus.play._
          import org.scalatestplus.play.guice._
          import play.api.test._
          import play.api.test.Helpers._

          class HomeControllerSpec extends PlaySpec with GuiceOneAppPerTest with Injecting {
            "HomeController GET" should {
              "return the project name" in {
                val controller = inject[HomeController]
                val result = controller.index().apply(FakeRequest(GET, "/"))
                status(result) mustBe OK
                contentAsString(result) must include("${name}")
              }
            }
          }
        `,
        ),
      ];
    case "vapor":
      return [
        file(
          `Tests/${name}Tests/AppTests.swift`,
          `
          @testable import ${name}
          import XCTVapor
          import Vapor

          final class AppTests: XCTestCase {
              func testHome() async throws {
                  let app = try await Application.make(.testing)
                  try configure(app)
                  try await app.test(.GET, "/") { res async in
                      XCTAssertEqual(res.status, .ok)
                      XCTAssertEqual(res.body.string, "${name}")
                  }
                  try await app.asyncShutdown()
              }
          }
        `,
        ),
      ];
    case "ring":
      return [
        file(
          `test/${names.snake}/core_test.clj`,
          `
          (ns ${names.snake}.core-test
            (:require [clojure.test :refer [deftest is]]
                      [${names.snake}.core :as core]))

          (deftest home
            (let [response (core/handler {})]
              (is (= 200 (:status response)))
              (is (= "${name}" (:body response)))))
        `,
        ),
      ];
    case "mojolicious":
      return [
        file(
          "t/app.t",
          `
          use Mojo::Base -strict;
          use Test::More;
          use Test::Mojo;

          require './app.pl';

          my $t = Test::Mojo->new;
          $t->get_ok('/')->status_is(200)->content_like(qr/${name}/);
          done_testing();
        `,
        ),
      ];
    case "giraffe":
      return [
        file(
          `tests/${slug}.Tests.fsproj`,
          `
          <Project Sdk="Microsoft.NET.Sdk">
            <PropertyGroup>
              <TargetFramework>net8.0</TargetFramework>
              <IsPackable>false</IsPackable>
            </PropertyGroup>
            <ItemGroup>
              <Compile Include="HomeTests.fs" />
              <ProjectReference Include="../${slug}.fsproj" />
              <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="8.0.11" />
              <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
              <PackageReference Include="xunit" Version="2.9.2" />
              <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
            </ItemGroup>
          </Project>
        `,
        ),
        file(
          "tests/HomeTests.fs",
          `
          module HomeTests

          open Microsoft.AspNetCore.Mvc.Testing
          open Xunit

          [<Fact>]
          let \`\`GET / returns the project name\`\` () =
              task {
                  use factory = new WebApplicationFactory<Program>()
                  use client = factory.CreateClient()
                  let! body = client.GetStringAsync("/")
                  Assert.Equal("${name}", body)
              }
        `,
        ),
      ];
    case "laravel":
      return [
        file(
          "tests/Feature/HomeTest.php",
          `
          <?php

          namespace Tests\\Feature;

          use Tests\\TestCase;

          class HomeTest extends TestCase
          {
              public function test_home_is_ok(): void
              {
                  $this->get('/')->assertOk();
              }
          }
        `,
        ),
      ];
    case "symfony":
      return [
        file(
          "phpunit.xml",
          `
          <?xml version="1.0" encoding="UTF-8"?>
          <phpunit bootstrap="vendor/autoload.php" colors="true">
              <testsuites>
                  <testsuite name="Project Test Suite">
                      <directory>tests</directory>
                  </testsuite>
              </testsuites>
          </phpunit>
        `,
        ),
        file(
          "tests/Controller/HomeControllerTest.php",
          `
          <?php

          declare(strict_types=1);

          namespace App\\Tests\\Controller;

          use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;

          final class HomeControllerTest extends WebTestCase
          {
              public function testHome(): void
              {
                  $client = static::createClient();
                  $client->request('GET', '/');
                  self::assertResponseIsSuccessful();
                  self::assertStringContainsString('Hello, world!', (string) $client->getResponse()->getContent());
              }
          }
        `,
        ),
      ];
    default:
      return [];
  }
}

function patch(kindId: string, files: readonly StarterFile[]): StarterFile[] {
  switch (kindId) {
    case "nextjs":
    case "astro":
      return addNpm(files, { test: "playwright test" }, { "@playwright/test": "^1.55.0" });
    case "nuxt":
      return addNpm(
        replacePath(
          files,
          "nuxt.config.ts",
          "export default defineNuxtConfig({\n  modules: ['@nuxt/test-utils/module'],\n});\n",
        ),
        { test: "vitest run" },
        {
          "@nuxt/test-utils": "^3.19.0",
          "@vue/test-utils": "^2.4.6",
          "happy-dom": "^17.0.0",
          vitest: "^3.0.0",
        },
      );
    case "react":
      return addNpm(
        files,
        { test: "vitest run" },
        { "@testing-library/react": "^16.2.0", jsdom: "^26.0.0", vitest: "^3.0.0" },
      );
    case "vuejs":
      return addNpm(files, { test: "vitest run" }, { "@vue/test-utils": "^2.4.6", jsdom: "^26.0.0", vitest: "^3.0.0" });
    case "angular":
    case "nestjs":
    case "remix":
    case "sveltekit":
    case "vite":
      return addNpm(files, { test: "vitest run" }, vitestDev(kindId));
    case "express":
    case "fastify":
    case "node":
    case "bootstrap":
    case "html5-boilerplate":
      return addNpm(files, { test: "node --test" }, {});
    case "react-native":
      return addNpm(
        files,
        { test: "jest" },
        {
          "@types/jest": "^29.5.14",
          "@types/react-test-renderer": "^19.0.0",
          jest: "^29.7.0",
          "react-test-renderer": "^19.0.0",
        },
      );
    case "django":
      return append(
        files.map((starter) =>
          starter.path === "config/settings.py"
            ? {
                path: starter.path,
                contents: starter.contents.replace(
                  'ALLOWED_HOSTS = ["127.0.0.1", "localhost"]',
                  'ALLOWED_HOSTS = ["127.0.0.1", "localhost", "testserver"]',
                ),
              }
            : starter,
        ),
        "requirements.txt",
        "pytest>=8.3\n",
      );
    case "flask":
      return append(files, "requirements.txt", "pytest>=8.3\n");
    case "fastapi":
      return append(files, "requirements.txt", "httpx>=0.28\npytest>=8.3\n");
    case "sinatra":
      return append(files, "Gemfile", 'gem "minitest", "~> 5.25"\ngem "rack-test", "~> 2.1"\n');
    case "spring":
      return append(files, "pom.xml", "").map((starter) =>
        starter.path === "pom.xml"
          ? {
              path: starter.path,
              contents: starter.contents.replace(
                "</dependencies>",
                `<dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
          </dependency>
        </dependencies>`,
              ),
            }
          : starter,
      );
    case "ktor":
      return files.map((starter) =>
        starter.path === "build.gradle.kts"
          ? {
              path: starter.path,
              contents: starter.contents.replace(
                'implementation("io.ktor:ktor-server-netty:3.0.3")',
                `implementation("io.ktor:ktor-server-netty:3.0.3")
          testImplementation("io.ktor:ktor-server-test-host:3.0.3")
          testImplementation("io.ktor:ktor-client-content-negotiation:3.0.3")
          testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.1.0")`,
              ),
            }
          : starter,
      );
    case "play":
      return append(
        files,
        "build.sbt",
        'libraryDependencies += "org.scalatestplus.play" %% "scalatestplus-play" % "7.0.1" % Test\n',
      );
    case "symfony":
      return files.map((starter) => {
        if (starter.path !== "composer.json") return starter;
        const pkg = JSON.parse(starter.contents) as { "require-dev"?: Record<string, string> };
        pkg["require-dev"] = {
          ...pkg["require-dev"],
          "phpunit/phpunit": "^12.0",
          "symfony/browser-kit": "8.1.*",
          "symfony/css-selector": "8.1.*",
        };
        return { path: starter.path, contents: `${JSON.stringify(pkg, null, 2)}\n` };
      });
    case "ring":
      return files.map((starter) =>
        starter.path === "deps.edn"
          ? {
              path: starter.path,
              contents: starter.contents.replace(
                '{:paths ["src"]',
                '{:paths ["src"]\n :aliases {:test {:extra-paths ["test"]}}',
              ),
            }
          : starter,
      );
    default:
      return [...files];
  }
}

function vitestDev(kindId: string): Record<string, string> {
  const vitest = { vitest: "^3.0.0" };
  if (kindId === "angular") return { ...vitest, jsdom: "^26.0.0" };
  if (kindId === "nestjs") return { ...vitest, "@nestjs/testing": "^11.0.0" };
  if (kindId === "remix" || kindId === "sveltekit") {
    return kindId === "remix"
      ? { ...vitest, "@testing-library/react": "^16.2.0", jsdom: "^26.0.0" }
      : { ...vitest, "@testing-library/svelte": "^5.2.0", jsdom: "^26.0.0" };
  }
  if (kindId === "vite") return { ...vitest, jsdom: "^26.0.0" };
  return vitest;
}

/** Adds the framework's own test file and the package that runs it. */
export function applyOfficialTests(kindId: string, names: Names, files: readonly StarterFile[]): StarterFile[] {
  if (!officialCase(kindId, names)) return [...files];
  const added = extras(kindId, names);
  const merged = new Map(files.map((starter) => [starter.path, starter]));
  for (const starter of added) merged.set(starter.path, starter);
  return patch(kindId, [...merged.values()]);
}
