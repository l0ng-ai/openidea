/** The phone app's frontend (`pnpm dev:phone` / `pnpm build:phone`): the app's config plus its dev-only eval bridge. */
import { defineConfig, mergeConfig } from "vite";
import app from "./vite.config";
import { phoneEval } from "./scripts/phone-eval";

export default defineConfig((env) => mergeConfig(app(env), { plugins: [phoneEval()] }));
