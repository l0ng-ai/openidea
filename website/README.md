# OpenIDEA website

The dark, responsive product homepage uses TanStack Start, StyleX and Base UI.
It is an independent pnpm package; desktop dependencies and commands are unchanged.
Its local workspace boundary keeps installation independent of the parent workspace.

```sh
cd website
pnpm install --frozen-lockfile
pnpm dev
```

Node 22.12+ and pnpm 11 are required. The image preview uses Base UI's Dialog for
keyboard focus management and Escape dismissal. Navigation and downloads are native
links. The debugger screenshot, logo and Inter font are hosted locally. Inter's license
is retained in `public/fonts/OFL.txt`.

## Static build

```sh
pnpm test
BASE_PATH=/openidea/ pnpm build
pnpm typecheck
BASE_PATH=/openidea/ pnpm check:static
pnpm preview
```

Open the preview at `/openidea/` when using that base path. Use `BASE_PATH=/` for a
custom-domain root or a user/organization Pages site. The deployable directory is
`dist/client/`; the server bundle is only used during prerendering and is not deployed.
No running Node server or API is required on GitHub Pages.

`check:static` validates that the initial HTML contains the homepage, benchmark and
measurement caveat, that component styles have been compiled, and that local media,
fonts and bundles exist under the selected base path.

## GitHub Pages

1. In the target repository, select **Settings → Pages → Build and deployment →
   Source: GitHub Actions**. Do this once before the first deployment.
2. Merge the website and `.github/workflows/website.yml` into `main`.
3. The Website workflow builds and deploys relevant main pushes. It can also be
   triggered manually from Actions on `main`. PRs build and validate without publishing.

`actions/configure-pages` supplies the repository prefix or custom-domain root and
canonical URL. The workflow uploads only `website/dist/client`. Deployment permissions
are restricted to the deploy job; no personal access token is needed by the workflow.
Check the existing `github-pages` environment's branch rules if GitHub blocks a deploy.

Homepage download buttons open the matching macOS, Windows or Linux page when a desktop
platform can be identified. Mobile and unknown systems open the platform chooser. Each
platform page links directly to actual installer assets, with explicit architecture and
package format choices. All download pages are prerendered and work without JavaScript.

`src/data/release.json` is a checked-in snapshot of the official stable release so local
builds work offline. Run `pnpm release:refresh` to refresh it from GitHub. CI refreshes it
before building; publishing a release or completing the Release workflow also rebuilds
the website. No browser-time GitHub API requests or API tokens are needed.

The benchmark follows the root README; update `src/components/Home.tsx` when the published
measurements change.
