/**
 * Web and PHP generators that PhpStorm lists beside the language starters.
 * Layouts follow the current CLI defaults (Angular workspace, Vite, Next app
 * router, Nuxt, a Composer library, a Joomla system plugin).
 */
import type { StarterChoices } from "./newProjectOptions";

interface Names {
  raw: string;
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

function npm(
  name: string,
  deps: Record<string, string>,
  dev: Record<string, string> = {},
  scripts: Record<string, string> = { dev: "vite", build: "vite build" },
): File {
  return file(
    "package.json",
    JSON.stringify(
      { name, private: true, version: "0.1.0", type: "module", scripts, dependencies: deps, devDependencies: dev },
      null,
      2,
    ),
  );
}

type Build = (n: Names, choices?: StarterChoices) => File[];

export const extraProjectBuilders: Record<string, Build> = {
  "composer-package": (n, choices) => {
    const name = choices?.packageName?.trim() || `example/${n.slug}`;
    return [
      file(
        "composer.json",
        JSON.stringify(
          {
            name,
            description: "",
            type: "library",
            license: "MIT",
            require: { php: ">=8.2" },
            autoload: { "psr-4": { [`${n.pascal}\\`]: "src/" } },
            config: { "sort-packages": true },
          },
          null,
          2,
        ),
      ),
      file(
        "src/Example.php",
        `
        <?php

        declare(strict_types=1);

        namespace ${n.pascal};

        final class Example
        {
            public static function hello(): string
            {
                return 'Hello, world!';
            }
        }
      `,
      ),
      file(".gitignore", ".DS_Store\nThumbs.db\nvendor/\n"),
    ];
  },
  joomla: (n) => [
    file(
      `${n.slug}.xml`,
      `
      <?xml version="1.0" encoding="UTF-8"?>
      <extension type="plugin" group="system" method="upgrade">
          <name>plg_system_${n.snake}</name>
          <version>0.1.0</version>
          <files>
              <filename plugin="${n.slug}">${n.slug}.php</filename>
          </files>
      </extension>
    `,
    ),
    file(
      `${n.slug}.php`,
      `
      <?php

      defined('_JEXEC') or die;

      use Joomla\\CMS\\Plugin\\CMSPlugin;

      /**
       * System plugin ${n.pascal}.
       */
      class PlgSystem${n.pascal} extends CMSPlugin
      {
      }
    `,
    ),
  ],
  angular: (n) => [
    npm(
      n.slug,
      { "@angular/core": "^19.0.0", "@angular/common": "^19.0.0", "@angular/platform-browser": "^19.0.0" },
      { typescript: "^5.7.0" },
      { start: "ng serve", build: "ng build" },
    ),
    file(
      "angular.json",
      JSON.stringify(
        {
          $schema: "./node_modules/@angular/cli/lib/config/schema.json",
          version: 1,
          newProjectRoot: "projects",
          projects: {},
        },
        null,
        2,
      ),
    ),
    file(
      "src/app.ts",
      `
      import { Component } from '@angular/core';

      @Component({
        selector: 'app-root',
        standalone: true,
        template: '<h1>${n.pascal}</h1>',
      })
      export class App {}
    `,
    ),
    file(
      "src/main.ts",
      `
      import { bootstrapApplication } from '@angular/platform-browser';
      import { App } from './app';

      bootstrapApplication(App);
    `,
    ),
    file(
      "src/index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <title>${n.pascal}</title>
          <base href="/">
      </head>
      <body>
          <app-root></app-root>
      </body>
      </html>
    `,
    ),
  ],
  bootstrap: (n) => [
    npm(n.slug, { bootstrap: "^5.3.0" }),
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${n.pascal}</title>
          <link rel="stylesheet" href="node_modules/bootstrap/dist/css/bootstrap.min.css">
      </head>
      <body>
          <main class="container py-4">
              <h1>${n.pascal}</h1>
          </main>
      </body>
      </html>
    `,
    ),
  ],
  express: (n) => [
    file(
      "package.json",
      JSON.stringify(
        {
          name: n.slug,
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: { start: "node index.js" },
          dependencies: { express: "^4.21.0" },
        },
        null,
        2,
      ),
    ),
    file(
      "index.js",
      `
      import express from 'express';
      import { pathToFileURL } from 'node:url';

      export const app = express();

      app.get('/', (_req, res) => {
        res.type('html').send('<h1>${n.pascal}</h1>');
      });

      if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
        app.listen(3000);
      }
    `,
    ),
    file(".gitignore", "node_modules/\n"),
  ],
  "html5-boilerplate": (n) => [
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${n.pascal}</title>
          <link rel="stylesheet" href="css/style.css">
      </head>
      <body>
          <main>
              <h1>${n.pascal}</h1>
          </main>
          <script src="js/main.js"></script>
      </body>
      </html>
    `,
    ),
    file("css/style.css", `body {\n  font-family: sans-serif;\n}`),
    file("js/main.js", `"use strict";\n`),
  ],
  nextjs: (n) => [
    file(
      "package.json",
      JSON.stringify(
        {
          name: n.slug,
          private: true,
          version: "0.1.0",
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: { next: "^15.5.0", react: "^19.0.0", "react-dom": "^19.0.0" },
          devDependencies: {
            "@types/node": "^22.0.0",
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
            typescript: "^5.7.0",
          },
        },
        null,
        2,
      ),
    ),
    file(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./*"] },
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
    ),
    file("next-env.d.ts", `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`),
    file(
      "next.config.ts",
      `
      import type { NextConfig } from 'next';

      const nextConfig: NextConfig = {};

      export default nextConfig;
    `,
    ),
    file(
      "app/layout.tsx",
      `
      import type { ReactNode } from 'react';

      export const metadata = { title: '${n.pascal}' };

      export default function RootLayout({ children }: { children: ReactNode }) {
        return (
          <html lang="en">
            <body>{children}</body>
          </html>
        );
      }
    `,
    ),
    file(
      "app/page.tsx",
      `
      export default function Page() {
        return <h1>${n.pascal}</h1>;
      }
    `,
    ),
    file(".gitignore", "node_modules/\n.next/\n"),
  ],
  node: (n) => [
    file(
      "package.json",
      JSON.stringify({ name: n.slug, private: true, version: "0.1.0", type: "module", main: "index.js" }, null, 2),
    ),
    file(
      "index.js",
      `
      import { pathToFileURL } from 'node:url';

      export function greeting() {
        return 'Hello, world!';
      }

      if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
        console.log(greeting());
      }
    `,
    ),
    file(".gitignore", "node_modules/\n"),
  ],
  nuxt: (n) => [
    file(
      "package.json",
      JSON.stringify(
        {
          name: n.slug,
          private: true,
          type: "module",
          scripts: { dev: "nuxt dev", build: "nuxt build", preview: "nuxt preview" },
          dependencies: { nuxt: "^4.0.0", vue: "^3.5.0" },
        },
        null,
        2,
      ),
    ),
    file("nuxt.config.ts", `export default defineNuxtConfig({});\n`),
    file("tsconfig.json", JSON.stringify({ extends: "./.nuxt/tsconfig.json" }, null, 2)),
    file(
      "app/app.vue",
      `
      <template>
        <h1>${n.pascal}</h1>
      </template>
    `,
    ),
    file(".gitignore", "node_modules/\n.nuxt/\n.output/\n"),
  ],
  react: (n) => [
    npm(
      n.slug,
      { react: "^19.0.0", "react-dom": "^19.0.0" },
      {
        "@types/react": "^19.0.0",
        "@types/react-dom": "^19.0.0",
        "@vitejs/plugin-react": "^4.3.0",
        typescript: "^5.7.0",
        vite: "^6.0.0",
      },
    ),
    file(
      "vite.config.ts",
      `
      import { defineConfig } from 'vite';
      import react from '@vitejs/plugin-react';

      export default defineConfig({ plugins: [react()] });
    `,
    ),
    file(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            useDefineForClassFields: true,
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            module: "ESNext",
            skipLibCheck: true,
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            isolatedModules: true,
            moduleDetection: "force",
            noEmit: true,
            jsx: "react-jsx",
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
    ),
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${n.pascal}</title>
      </head>
      <body>
          <div id="root"></div>
          <script type="module" src="/src/main.tsx"></script>
      </body>
      </html>
    `,
    ),
    file("src/vite-env.d.ts", `/// <reference types="vite/client" />\n`),
    file(
      "src/main.tsx",
      `
      import { StrictMode } from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from './App';

      createRoot(document.getElementById('root')!).render(
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
        return <h1>${n.pascal}</h1>;
      }
    `,
    ),
    file(".gitignore", "node_modules/\ndist/\n"),
  ],
  "react-native": (n) => [
    file(
      "package.json",
      JSON.stringify(
        {
          name: n.slug,
          private: true,
          version: "0.1.0",
          scripts: { start: "react-native start" },
          dependencies: { react: "^19.0.0", "react-native": "^0.76.0" },
        },
        null,
        2,
      ),
    ),
    file(
      "App.tsx",
      `
      import { Text, View } from 'react-native';

      export default function App() {
        return (
          <View>
            <Text>${n.pascal}</Text>
          </View>
        );
      }
    `,
    ),
    file(
      "index.js",
      `
      import { AppRegistry } from 'react-native';
      import App from './App';

      AppRegistry.registerComponent('${n.slug}', () => App);
    `,
    ),
    file(".gitignore", "node_modules/\n"),
  ],
  vite: (n) => [
    npm(n.slug, {}, { vite: "^6.0.0" }),
    file("vite.config.js", `import { defineConfig } from 'vite';\n\nexport default defineConfig({});\n`),
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <title>${n.pascal}</title>
      </head>
      <body>
          <div id="app"></div>
          <script type="module" src="/src/main.js"></script>
      </body>
      </html>
    `,
    ),
    file("src/main.js", `document.querySelector('#app').textContent = '${n.pascal}';\n`),
    file(".gitignore", "node_modules/\ndist/\n"),
  ],
  vuejs: (n) => [
    npm(
      n.slug,
      { vue: "^3.5.0" },
      { "@vitejs/plugin-vue": "^5.2.0", typescript: "^5.7.0", vite: "^6.0.0", "vue-tsc": "^2.2.0" },
      { dev: "vite", build: "vue-tsc -b && vite build" },
    ),
    file(
      "vite.config.ts",
      `
      import { defineConfig } from 'vite';
      import vue from '@vitejs/plugin-vue';

      export default defineConfig({ plugins: [vue()] });
    `,
    ),
    file(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            useDefineForClassFields: true,
            module: "ESNext",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            skipLibCheck: true,
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            isolatedModules: true,
            moduleDetection: "force",
            noEmit: true,
            jsx: "preserve",
            strict: true,
          },
          include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"],
        },
        null,
        2,
      ),
    ),
    file(
      "index.html",
      `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${n.pascal}</title>
      </head>
      <body>
          <div id="app"></div>
          <script type="module" src="/src/main.ts"></script>
      </body>
      </html>
    `,
    ),
    file(
      "src/vite-env.d.ts",
      `
      /// <reference types="vite/client" />

      declare module '*.vue' {
        import type { DefineComponent } from 'vue';
        const component: DefineComponent;
        export default component;
      }
    `,
    ),
    file(
      "src/main.ts",
      `
      import { createApp } from 'vue';
      import App from './App.vue';

      createApp(App).mount('#app');
    `,
    ),
    file(
      "src/App.vue",
      `
      <template>
        <h1>${n.pascal}</h1>
      </template>
    `,
    ),
    file(".gitignore", "node_modules/\ndist/\n"),
  ],
};
