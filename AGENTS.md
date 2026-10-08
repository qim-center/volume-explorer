# AGENTS.md

QIM Volume Explorer (`@qim3d/volume-explorer`): a 3D volumetric data explorer built on a fork of Allen's vole-core. Two packages in one repo:

- `src/` — the library (vole-core fork). Compiled by Babel to `es/`, types emitted to `es/types/`. Entry: `src/index.ts`.
- `public/` — the web app (Vite root is `public/`, so app code lives here, not in `src/`). Built to `dist/app/`, served by the CLI.

## Commands

- `npm run dev` — Vite dev server for the app (root `public/`, opens `/index.html`).
- `npm start` / `npm run preview` — run the packaged CLI (`bin/volume-explorer.js`) against the production build (`dist/` must be built first).
- `npm run checks` — runs lint, typecheck, and tests in parallel (what you should run before finishing work).
- `npm test` — vitest; run a single test with `npx vitest run src/test/<file>.test.ts`. Tests are in `src/test/` and use jsdom + globals (`describe`/`it` without imports).
- `npm run build` — clean + `transpileES` (babel `src/` → `es/`, ignores `*.test.ts`) + `build-types` + `build-app` (Vite → `dist/app`). Order matters if you rebuild partially.

## Gotchas

- `es/`, `dist/`, `demo/` are build artifacts (gitignored); `npm run build` wipes them. Do not edit generated files.
- CI runs three separate jobs: `lint`, `test`, `typeCheck` (Node 20).
- Pre-commit hook runs `lint-staged` (prettier on staged `src/**/*.js`).
- Shader files (`.glsl`, `.frag`, `.vert`) are imported and inlined at build time — Vite uses `vite-plugin-glsl`, Babel uses `babel-plugin-inline-import` — so imports of `.glsl` etc. look like they should fail typechecking but don't.
- `noImplicitAny` is off and `lib` includes `ScriptHost`/`DOM`; keep code ES6-target compatible (transpiled to ES6 by Babel).
- Dev setup requires the Python `aicsimage` lib for local `.tif`/`.czi`/OME-Tiff loading (not needed for Zarr-over-URL or tests).
- Publishing is done by CI on tag push (`npm version` + push main + push tag); see DEV.md.
