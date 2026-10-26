# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Gloss is a cross-platform translation + OCR desktop app: a React 19 frontend (Vite, HeroUI v3, Tailwind 4) inside a Tauri 2 shell. Package manager is **pnpm** (Node 22, see `.node-version` — pnpm 11 refuses to run below 22.13). pnpm >= 10 needs every dependency build script decided explicitly, so a new dep with a postinstall goes in the `allowBuilds` map in `pnpm-workspace.yaml` or it is silently skipped.

It is a fork of [pot](https://github.com/pot-app/pot-desktop), renamed to **Gloss** — the word for the interlinear translation written beside a difficult line, which is what the in-place image overlay does. The rename is deliberately skin-deep in one place: the bundle identifier is still `com.pot-app.desktop`, because Tauri derives `appConfigDir()` from it and that directory holds the user's `config.json`, `history.db` and installed `.potext` plugins. Changing it would strand every existing install's data, and `backup.rs` hardcodes the same string in five places. Rename it only together with a migration that moves the old directory across.

Three other things still say "pot" on purpose: `https://pot-app.com/**` (upstream's docs, dictionary API, plugin store, and `lingva.pot-app.com` — real endpoints, not branding), the Anki deck `Pot` / note type `Pot Card 2` and the Eudic notebook default `pot` (renaming those would split a user's existing collection), and `pt_br = 'pot'` in three `info.ts` files, which is Baidu's language code for Portuguese.

## Commands

```bash
pnpm install            # install JS deps
pnpm tauri dev          # run the app (starts vite on :1420, then cargo)
pnpm dev:mcp            # same, but merges src-tauri/tauri.dev.conf.json (withGlobalTauri: true)
pnpm tauri build        # build installers for the current platform
pnpm dev                # frontend only — mostly useless, every window calls into Tauri
pnpm test               # vitest, one pass (what CI runs)
pnpm test:watch         # vitest, watching
pnpm test src/utils/http.test.js       # one file (`vitest run` takes a path filter; -t filters by name)
npx prettier --write .  # format (config in .prettierrc.json: 4 spaces, single quotes, 120 cols)
```

`dev:mcp` exists for the two MCP servers in `.mcp.json`: `tauri` (`@hypothesi/tauri-mcp-server`, drives the running app — windows, DOM, screenshots, IPC — and needs `withGlobalTauri`) and `heroui` (`@heroui/mcp`, v3 component docs/props/source). Reach for the HeroUI one before guessing at a v3 prop; the v2→v3 migration here has already been bitten by props v3 accepts and ignores.

The `tauri` server talks to a Rust half that has to be present too: `tauri-plugin-mcp-bridge`, registered in `main.rs` under `cfg(debug_assertions)` with `Config::localhost_only()` (the plugin otherwise binds `0.0.0.0`, which would let anyone on the network drive these windows), plus `mcp-bridge:default` in the capability file. All three pieces are already in the tree, so a failed connect is almost always the third one missing at runtime — i.e. the app was started with `pnpm tauri dev` instead of `pnpm dev:mcp`.

Linux dev also needs (per `.github/actions/build-for-linux/entrypoint.sh` — note the README still lists the Tauri 1 webkit 4.0 packages): `libgtk-3-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev libxcb1 libxrandr2 libdbus-1-3 libpipewire-0.3-dev libspa-0.2-dev clang libclang-dev`.

The last seven are for `xcap`, the screenshot backend: it depends on `pipewire` unconditionally on Linux (that is its Wayland capture path, and it is not behind a feature), which drags in `libspa-sys` — a crate that both probes `libpipewire-0.3.pc` through pkg-config and runs bindgen over its headers. Its `build.rs` never passes `--target` to clang, so **cross builds must set `BINDGEN_EXTRA_CLANG_ARGS`** with the target triple and multiarch include dir or bindgen silently sizes the bindings for the host.

The same path links against gbm and EGL (`-lgbm -lEGL`, from the `gbm`/`gbm-sys`/`khronos_egl` crates). The `rust:bookworm` image carries those runtime libraries but not the `.so` symlinks, so they need `-dev` packages as well — and because nothing references them until the final link, a missing one surfaces as `rust-lld: error: unable to find library -lgbm` only after the whole crate graph has already compiled.

Tests are **vitest** (`46608c2`), matching `src/**/*.test.{js,jsx,ts,tsx}` — four files so far: `utils/crypto`, `utils/db`, `utils/http`, `services/config-forms`. `vitest.config.js` is deliberately separate from `vite.config.js`, which carries the build targets and watch exclusions the Tauri build depends on. The default environment is `node`; a file that needs a DOM opts in with a `// @vitest-environment jsdom` docblock on its first line. `vitest.setup.js` fills the three globals jsdom lacks but the app touches **at import time**: WebCrypto (the real one from `node:crypto`, so a test that signs something gets a real signature), an `AudioContext` stub (`useVoice` constructs one at module scope, so merely importing the hooks barrel throws without it), and `window.__TAURI_EVENT_PLUGIN_INTERNALS__` (`mockIPC` does not install it, and every unmounted `useConfig` rejects on cleanup without it).

`.github/workflows/test.yml` runs `pnpm test` on every PR — Node only, no cargo, under a minute. There is still **no lint script** and no `prettier --check` gate; 16 files in the tree do not satisfy it yet, and that workflow's comment lists them. Rust has no tests at all: verification there is `cargo check`/`cargo clippy` from `src-tauri/`, and for anything visual, running the app.

Release packaging happens in `.github/workflows/package.yml` on push to `master`; it rewrites the version in `package.json`, `src-tauri/tauri.conf.json` and `Cargo.toml` from `git describe --tags`, so those version fields are not hand-maintained.

## Architecture

### One bundle, five windows

`index.html` → `src/main.jsx` → `src/App.jsx`. There is a single JS bundle; **which UI renders is chosen by the Tauri window label**, not by the router:

```js
const windowMap = { translate, screenshot, recognize, config, updater };
return <BrowserRouter>{windowMap[appWindow.label]}</BrowserRouter>;
```

Each entry maps to `src/window/<Name>/`. Rust creates those windows (`src-tauri/src/window.rs`: `translate_window`, `recognize_window`, `screenshot_window`, `config_window`, `updater_window`) positioned on the monitor under the mouse. A hidden `daemon` window (`daemon.html`, the second Vite rollup input) exists only so the backend always has a webview to query monitors from.

Side effects shared by the windows live in hooks rather than in the window components (`0d74bc1`): `useAppConfig()` applies theme, language and typeface and is called once from `App.jsx`; `useKeyboardShortcuts()` swallows the browser keys a webview offers that mean nothing in a non-browser window (only `ctrl` + `c/v/x/a/z/y` survive, and F12 opens devtools when `dev_mode` is set); `useWindowLifecycle.jsx` holds `useCloseOnBlur` and `usePersistWindowGeometry`. `useCloseOnBlur` _queues_ the close instead of acting on the blur, because on Windows starting to drag a window fires blur and then focus straight back — focus or move cancels it. These three are **not** re-exported from `src/hooks/index.jsx`; import them by path.

Entry points into those windows: global hotkeys (`hotkey.rs`), tray menu (`tray.rs`), clipboard monitor (`clipboard.rs`), and a localhost HTTP server on port `server_port` (default 60828, `server.rs`) used by the PopClip/SnipDo extensions in `.scripts/`.

### Config store — the app's shared state

Everything user-facing lives in one JSON store (`config.json` in the app config dir), managed by `tauri-plugin-store` and reachable from both sides:

- Rust: `config.rs` `get(key)` / `set(key, value)`.
- JS: `src/utils/store.js` exports a `LazyStore`; `initStore()` also installs an fs watcher that reloads it and calls `invoke('reload_store')`.
- React: **always use `useConfig(key, default)`** (`src/hooks/useConfig.jsx`). It seeds missing keys with the default, debounces writes back to the store, and emits/listens on a `<key>_changed` Tauri event so every window stays in sync (`.` and `@` in the key become `_` and `:` in the event name).

History and the translation cache live in SQLite, not the store. **Everything that touches sqlite goes through `src/utils/db.js`** — it owns the single shared connection plus the schema and indexes for both tables, so callers can assume they exist. Don't call `Database.load('sqlite:history.db')` directly (the one exception is `invoke_plugin.js`, which hands the raw `Database` class to `.potext` plugins).

The cache key is a hash of the text, languages, service instance **and its config** (`buildCacheKey`), so editing a prompt or endpoint misses the cache rather than replaying a stale result. The glossary signature is appended to it, and only when there is one — a user who keeps no terms keeps every key they already had.

### Services (translate / recognize / tts / collection)

`src/services/<type>/<name>/` is the unit of extension, each with three files:

- `info.ts` — `info = { name, icon }` plus a `Language` enum mapping Gloss's language codes to the provider's.
- `index.jsx` — the actual call, e.g. `translate(text, from, to, { config })`; throws a string on failure.
- `Config.jsx` — the settings form, assembled from the shared parts below rather than hand-written.

Since `0f30603` the forms are built out of `src/components/ServiceConfigForm`, which owns the wiring all of them repeated: load this instance's config with `useConfig(instanceKey, defaultConfig, { sync: false })`, test-call the service on submit, and only once that call resolves persist (a forced `setConfig(config, true)`, since the hook is unsynced) and close — otherwise toast the string the service threw. `children` is a render prop, `(config, setConfig) => rows`, because the rows need the config the component owns. `defaultConfig` is also merged over the stored config on read: `useConfig` seeds defaults only when the key is absent altogether, and plenty of instances are stored as a fragment like `{enable: false}`, whose fields would otherwise render blank.

The rows come from `ServiceConfigForm/ConfigField.jsx` — `TextConfigField`, `TextAreaConfigField`, `SelectConfigField`, `SwitchConfigField`, `HelpLink`, each taking `hidden` as a **prop** rather than being wrapped in a conditional element, because `.config-item` is the flex row itself. `NoConfigForm` is the entire form for the nine services that take no settings, and `PromptListEditor` (with one of the three `*_PROMPT_SCHEMA` constants) the LLM prompt list.

That consolidation is what makes `src/services/config-forms.test.jsx` worth having: it renders all 43 forms, so a field name that does not match the service's config or an i18n key that does not exist fails there instead of in a dialog nobody opened. A new service is covered by it automatically.

Register a new service by adding it to the barrel `src/services/<type>/index.jsx` **and** adding `services.<type>.<name>.*` strings to `src/i18n/locales/en_US.json` (other locales come from Weblate — only edit `en_US.json` and `zh_CN.json` by hand).

Users can configure **multiple instances of the same service**. The key is `name@randomId` (`src/utils/service_instance.ts`: `createServiceInstanceKey`, `getServiceName`, `whetherPluginService`); that key is both the config-store key and the list entry. Keys starting with `plugin` are third-party `.potext` plugins installed into `$APPCONFIG/plugins/<type>/<name>/`, loaded at call time by `invoke_plugin()` (`src/utils/invoke_plugin.js`), which `eval`s the plugin's `main.js` and hands it a `utils` object. `config.rs::check_service_available` prunes configured services whose builtin/plugin backing has disappeared.

The `tesseract` recognize service is the one with a runtime that is **not** in the JS bundle: it points `workerPath`/`corePath` at `public/worker.min.js` and `public/tesseract-core-simd-lstm.wasm.js`, which are vendored copies of `tesseract.js`'s `dist/worker.min.js` and `tesseract.js-core`'s SIMD+LSTM core. Bumping the npm dep alone changes only the main-thread half and leaves the worker behind — they had silently drifted apart (dep 5.1.1, vendored worker 5.0.0) until the 7.0.0 bump re-synced them. So upgrading means all three together:

```bash
cp node_modules/tesseract.js/dist/worker.min.js public/worker.min.js
cp node_modules/.pnpm/tesseract.js-core@<v>/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js public/
```

Only the one SIMD+LSTM core is vendored (~3.9 MB, wasm embedded in the `.js`); pointing `corePath` at a directory instead would make tesseract.js pick a variant per device and require shipping all six (~25 MB), and since v7 that set includes relaxed-SIMD builds that older WebViews cannot run. `langPath` is the upstream pot project's R2 mirror of the traineddata, unrelated to the npm version.

### The Tauri 1 compatibility layer (important)

This branch migrated from Tauri 1.8 to Tauri 2 (`d44c7bb`). Two shims deliberately preserve the v1 surface, because ~37 service files _and every third-party plugin_ are written against it — **don't "modernize" call sites into raw v2 APIs**:

- `src/utils/http.js` — exports `fetch`/`Body`/`ResponseType` with the v1 shape (`res.ok`/`res.status`/`res.data`, `Body.json|text|form`, `query`, `responseType`) on top of `@tauri-apps/plugin-http`.
- `src/utils/env.js` — remaps v2's `linux|macos|windows` back to `Linux|Darwin|Windows_NT`, which the UI, `public/logo/*.svg` and plugins expect.

Other v2 consequences worth knowing: core APIs are now 15 separate plugins (see `Cargo.toml` / `package.json`); every frontend capability must be allow-listed in `src-tauri/capabilities/default.json` (a missing permission fails at runtime, e.g. `data-tauri-drag-region` needs `core:window:allow-start-dragging`); the store returns `undefined` (not `null`) for missing keys.

The `allow` entries in that capability file are **URLPatterns**, and one omitted segment does not behave like the others: leaving the _port_ out matches the protocol's default port only. `{ "url": "http://*" }` therefore reached example.com but rejected `127.0.0.1:60828` with `url not allowed on the configured scope` — which broke the Recognize window's translate button (it POSTs to Gloss's own local server), the Anki collection service on 8765, and every self-hosted endpoint a user had configured. The _path_ segment does default to a wildcard, which is why the other 36 services never noticed. `http:default` allows `http://*:*` and `https://*:*` for that reason.

### Custom CSS must be wrapped in a layer

Tailwind 4 emits its utilities inside `@layer utilities`, and **unlayered CSS beats every cascade layer regardless of specificity**. Any plain rule in `src/style.css` or a component `style.css` therefore silently overrides the utility classes it collides with — this is not a specificity problem and adding classes will not fix it. Put app CSS in `@layer base` (resets) or `@layer components` (component classes), which is where `* { margin: 0 }` and `.config-item` now live. Under Tailwind 3 the same code was fine, because v3 emitted unlayered utilities that simply outranked `*` on specificity.

Two consequences of that, both load-bearing:

- **Inside `@layer components` nothing but source order separates your rule from HeroUI's.** `@heroui/styles` puts every `.button` / `.input` / `.modal__*` rule in that same layer, so a class of yours at the same specificity wins only if it is emitted later. That is why window stylesheets are `@import`ed from `src/style.css` **after** `@import '@heroui/styles'` (`src/window/Translate/style.css`) rather than from the window's own `index.jsx` — App.jsx imports the window components above its `import './style.css'`, so from there they would land first and lose every tie. When overriding a HeroUI component, also prefer its own custom properties over the declarations they feed: `.button` paints `background-color: var(--button-bg)` and hovers to `var(--button-bg-hover)`, so setting `background` alone leaves the hover state pointing at the accent.
- **For `!important` declarations the layer order reverses, and unlayered is the weakest.** `src/style.css` ends with an unlayered `html { border-radius: 10px !important }` for the frameless windows; anything that has to beat it (a theme squaring the window off, say) can do so from `@layer base` with a plain `!important` and no specificity race.

### Themes

HeroUI v3 is CSS-first: there is no `tailwind.config.cjs` and no HeroUI plugin any more. A theme is four things:

1. `src/themes/<name>.css` — a `@layer base { [data-theme='<name>'] { … } }` block of token values, modelled on `light.css` (which documents how the old v2 scale maps onto v3's names).
2. an `@import` for it in `src/style.css`.
3. an entry in `colorThemes` (`src/utils/theme.js`), which keeps the Settings dropdown and the `next-themes` provider in sync — next-themes only strips the themes it was told about, so a name missing from that list gets written onto `<html>` and never removed.
4. a `config.general.theme.<name>` string in `en_US.json`/`zh_CN.json`, plus an icon in the `themeIcon` map in `src/window/Config/pages/General/index.jsx` (it falls back to the monitor glyph, so a missing entry is silent).

A dark theme also has to be added to the `@custom-variant dark` list at the top of `src/style.css`, or every `dark:` utility — the app's own handful plus the many HeroUI's components carry — resolves to its light value under it.

Because every surface in the app is painted with v3 tokens (`bg-surface`, `text-muted`, `border-border`, `text-accent`), a colours-only theme needs no component changes at all. Two tokens are worth knowing about beyond the palette:

- `--radius` is the root of Tailwind's whole radius scale here — `@heroui/styles` defines `--radius-xs … --radius-4xl` as multiples of it — so a single `--radius: 0rem` squares off every component in the app, including the `rounded-3xl` baked into `.button`.
- `--border` / `--border-secondary` are the hairline and the strong rule. The translate window's layout is built entirely on that pair (`src/window/Translate/style.css`), which is what lets the same markup read correctly under every theme.

Only `light` and `dark` ship (the `nocturne` and `modernist` experiments were removed in `2835314`), so `src/window/Config/style.css` currently declares the plain `@layer theme, base, components, utilities;` — see the comment there for why that file, not `src/style.css`, has to own the statement. A theme that wants to restyle utility **classes** rather than just retint the tokens behind them has to append its own layer after `utilities` in that same statement, because nothing in `components` can outrank a utility. Two traps that path has hit before: `backdrop-filter` establishes a containing block for `position: fixed` descendants, so it must not go on the `bg-background` shells that hold the `data-tauri-drag-region` strips; and lightningcss merges a property with its own prefixed forms, so hand-writing `-webkit-backdrop-filter` makes it emit _only_ the legacy property, which Chrome 151/WebView2 no longer supports.

Anything reading a theme colour from JS should pass the var through as a string (`'var(--surface)'`) rather than branching on the theme name — it resolves against whatever `data-theme` is on `<html>` at paint time, so it stays correct for themes added later and needs no re-render on a theme switch. Note that v3's tokens are **complete colour values**, where v2's `--heroui-*` were bare HSL triplets meant to be wrapped: `hsl(var(--heroui-content1))` is now an invalid colour that silently falls back, and translucency is `color-mix(in oklab, var(--x) N%, transparent)` rather than `hsl(var(--x) / 0.N)`. `useToastStyle` was the one place that survived the migration still naming them, so every toast in the app drew the library's white default under a dark theme until it was pointed at `--overlay`.

### Icons

Two full sets, because `tauri.macos.conf.json` points `bundle.icon` at its own directory: `src-tauri/icons/` and `src-tauri/icons_mac/`. Both are generated output. The source of the app icon is **`public/icon.svg`** itself, which is also the runtime asset the Config sidebar loads, so there is one copy rather than a source and a duplicate that drift.

`tauri icon` takes an SVG directly, so nothing needs rasterising first:

```bash
pnpm tauri icon public/icon.svg                            # src-tauri/icons
pnpm tauri icon public/icon.svg -o src-tauri/icons_mac     # the macOS set
pnpm tauri icon public/icon.svg -o <tmp> --png 820         # then copy to public/icon.png
pnpm tauri icon design/tray-color.svg -o <tmp>             # icon.ico + 128x128.png -> icons/tray.{ico,png}
pnpm tauri icon design/tray-macos.svg -o <tmp>             # icon.ico -> icons_mac/tray.ico
```

It writes `android/`, `ios/` and a `64x64.png` that this desktop-only project has no use for; delete them after each run or they land in the diff.

**The tray needs two variants and they are not interchangeable.** `iconAsTemplate` maps to a macOS-only API: up there the system keeps only the alpha channel and repaints the glyph to match the menu bar, so `icons_mac/tray.ico` is a solid black silhouette. Windows and Linux ignore the flag and draw the image as-is, so the same black glyph would disappear on a dark Windows 11 taskbar — `icons/tray.ico` is the same geometry in mid grey and accent blue, which holds on a light and a dark bar alike. Each platform config carries its own `iconPath`, so the one in `tauri.conf.json` never applies on desktop; both platform files used to point the tray at the full-colour app icon.

`design/` holds the two tray sources. Keep their geometry in step with each other — only the palette differs.

One trap when editing any of these by hand: **an XML comment cannot contain a double hyphen**, so a `--` used as a dash inside `<!-- -->` makes resvg fail the parse and `tauri icon` panics with `InvalidComment` rather than a readable error.

### Toasts and modals

Both are overlay surfaces and both are styled centrally rather than per call site.

**Toasts.** `<AppToaster />` is mounted once per window from `App.jsx`, and that placement is load-bearing: a `<Toaster>` renders every toast sharing its `toasterId`, all of them take the default id, and there used to be sixteen — one per page plus one inside several of the modals those pages open — so a page with a modal on top of it drew each toast twice. It owns position, duration and `iconTheme`; the icons point at `--accent` and `--danger` instead of the library's two hard-coded hexes. The 55 call sites keep passing `useToastStyle()`, which is the same object `AppToaster` hands to `toastOptions.style`, so the two agree whichever way a toast is raised.

**Modals.** `.modal__dialog` carries no padding of its own; `__header`, `__body` and `__footer` carry theirs, which is what lets the 2px rules between them run edge to edge instead of stopping short at both ends. Fields inside a modal are squared with a 2px edge like the ones on the flat surfaces — v3 draws them as a borderless 12px pill, which on the dialog's `--overlay` grey read as floating white lozenges. All of it is one rule each in `src/style.css` rather than a className on twelve call sites.

A dismiss button is `tertiary`, not `danger-soft`. Ten of them were danger, which put Cancel in the same colour as Delete and left the colour saying nothing; the seven that are still `danger-soft` all genuinely destroy something.

Note that the native screenshot the Tauri MCP takes **does not capture a toast**: react-hot-toast animates one in on its own compositing layer, and a window-level capture on Windows drops GPU-composited layers. It is in the DOM and hit-testable the whole time, so verify one by reading computed styles, not by looking for it in a picture.

### The flat surfaces

`src/styles/flat.css` holds the shared primitives for the redesigned surfaces — no cards or fills, rules doing the dividing, flush-left uppercase actions, machine facts (dimensions, char counts, service names) in a quieter face. The Recognize window and the Service settings page are built from it; **`src/window/Translate/style.css` predates it and carries its own copies of the same three ideas** (`.translate-action` / `.translate-meta` / `.translate-primary`), so a change touching both surfaces should converge them into `flat.css` rather than edit two sets.

Chrome there is sized in `px` and content in `rem` deliberately: `App.jsx` writes the user's `app_font_size` onto `<html>`, so `1rem` _is_ their chosen reading size — body copy tracks it while rules, labels and status text stay at the size the design draws them.

### In-place image translation

The Recognize window can paint a translation back over the captured image (`src/window/Recognize/ImageArea/InPlaceOverlay.jsx`). It is the one feature that goes around the normal translate path: it calls `system_ocr_layout` for per-line boxes, groups lines that are plainly one paragraph (adjacent, similar height, horizontally overlapping) so wrapped sentences translate as prose, then translates through `translate_dispatch.js` and reads/writes the same `db.js` cache itself.

It runs on **Windows and Linux**. `ocr_layout.rs` has a backend per platform: `Windows.Media.Ocr` reports a `BoundingRect` per word, and on Linux the same `tesseract` binary `system_ocr` already shells out to is asked for `stdout tsv` instead, which is the identical recognition with the geometry left in. Both fold words into lines by unioning the boxes, because a line's own rectangle is the type area rather than the ink. macOS is the gap, and not for want of data — Vision reports a `boundingBox` too — but Gloss reaches it through the prebuilt `resources/ocr-*-apple-darwin` binary, whose contract is a finished string and whose source is not in this repository.

It asks `resolveService` for `stream: false`, because it translates every block at once and paints each only when finished, so it hands `callService` no `setResult` — and ollama, openai and geminipro all answer "stream with nobody to stream to" by aborting and returning the literal string `'[STREAM]'`, which used to get painted over the image _and cached under that block's key_.

The geometry is the part that is genuinely local to this file. The overlay is positioned over the whole pane while the `<img>` is sized to the image and centred in it, so `measure()` has to add the element's own `offsetLeft`/`offsetTop` to whatever `object-contain` letterboxed inside it. Accounting for only the second put every box a hundred pixels above a wide, short capture.

The one frontend consequence of the platform split is `toOcrLanguage`: each engine wants its own spelling, so it picks `linuxLangMap` or `windowsLangMap` off `osType`. Handing tesseract a BCP-47 tag fails as a missing language package rather than as a bad argument, so getting that wrong looks like a user problem.

`src/utils/ai_presets.js` is the other thing layered onto translation: named prompt presets (`polish`, `summarize`, `grammar`, `explain_code`) that swap an LLM service's `promptList` for one request without touching its saved config. Only the services listed in `PROMPT_SERVICES` read a prompt at all; the rest take a language pair and have nowhere to put an instruction.

### The shared translate dispatch

`src/utils/translate_dispatch.js` is the path between "the user picked a service" and "the service was called". Three steps, in order, and both the Translate window and the Recognize window's in-place overlay walk all three:

- `resolveService(instanceKey, { pluginList, savedConfig, preset, stream })` — the config the call is actually made with, and the language table. It sets the plugin `enable` flag, applies the AI preset, and honours `stream: false` for a caller with nowhere to put partial text. Every one of those returns a **copy**; nothing writes into the caller's `savedConfig`, which the Translate window keeps in a map for the whole session.
- `withGlossary(resolved, { from, to })` — the terms, folded into the config or into a result rewriter. Separate from the step above because the language pair is not final until after the service's own language support has been checked.
- `callService(resolved, text, from, to, { detect, setResult })` — the builtin-versus-plugin dispatch.

The cache is deliberately **not** in here: both callers use `buildCacheKey` and the `db.js` helpers directly, because their control flow around a hit genuinely differs — the Translate window has to tell a hit from a miss to report where the answer came from and to hold its own race guard, while the overlay runs the lookup per block inside a concurrency limiter.

These were two separate implementations until they were merged, 193 lines against 74, and they had already drifted twice: the `'[STREAM]'` bug below came from the overlay passing `setResult: null` where the Translate window passes a function, and the glossary had to be written into both files. A change to how a translation is prepared now has one place to go.

### Glossary

Terms the user wants rendered a particular way, stored in the same sqlite file as history and the cache (`glossary` table, CRUD in `db.js` like everything else that touches sqlite) and edited on the Config window's Glossary page. An entry is scoped by language pair, where `'all'` on either side is the wildcard; `getActiveGlossary(from, to)` is what a translation asks for, and `from` is the _detected_ language when the source is set to auto, since nobody scopes a term to "auto".

The application is two-tier, and `src/utils/glossary.js` holds both halves as pure functions:

- **LLM services** (the same `PROMPT_SERVICES` list `ai_presets` uses) get the terms as an instruction appended to their first prompt message, so the model applies them while translating. That is the only way "render `bug` as 缺陷" can work at all — by the time a finished translation exists the word is gone. `applyGlossaryToConfig` returns a _copy_ of the config, exactly as `applyPreset` does, which is also what makes the cache key move on its own.
- **Everything else** takes a language pair and has nowhere to put an instruction, so there the terms are applied to the result. That reaches what actually dominates a glossary — proper nouns and jargon an engine passes through untranslated — and it cannot damage anything: a term the engine did translate simply is not found. Pre-substituting a sentinel would cover the rest, but an engine that drops or mangles the sentinel takes the user's words with it, and losing text is worse than not rewriting it.

Which of the two applies is decided by `instanceConfig !== presetConfig`, not by asking `supportsPrompt` a second time: `applyGlossaryToConfig` also declines when an LLM instance was saved before it had a `promptList`, and that instance does want the result rewritten.

Two details in `applyGlossaryToResult` that look arbitrary and are not: word boundaries are added only where the term's own edge is an ASCII word character (JS `\b` is ASCII, so demanding one around a CJK term demands a boundary that never occurs — while a Latin term without one rewrites the middle of another word, and an entry for `AI` would hit `SAID`), and every term goes into **one** alternation sorted longest-first rather than a replace per term, so a replacement containing another term is not then rewritten itself.

Both halves are reached through `withGlossary` in `translate_dispatch.js`, so this is wired in once — see below.

### Rust module map (`src-tauri/src/`)

`main.rs` wires plugins, the global `APP: OnceCell<AppHandle>`, and the `invoke_handler` list — a new `#[tauri::command]` must be added there _and_ usually needs a capability entry. `cmd.rs` misc commands (image cropping, clipboard image, plugin install, fonts, history export, devtools). `screenshot.rs` the capture itself; `proxy.rs` per-OS system proxy discovery. `system_ocr.rs` per-OS native OCR (Windows.Media.Ocr / macOS Vision / Linux tesseract binary), text only. `ocr_layout.rs` the same engines but returning a box per line — Windows and Linux only (see above); its TSV parser is deliberately outside the `cfg` gate so it compiles and is unit-tested on any host. `tts.rs` per-OS offline speech (Windows.Media.SpeechSynthesis / macOS `say` / Linux `espeak-ng`) and `edge_tts.rs` Edge's read-aloud voices, which live in Rust because the WebSocket handshake needs `Origin`/`User-Agent` headers a webview cannot set; both return base64 WAV because the IPC layer would otherwise serialize the audio as a JSON number array. `lang_detect.rs` offline detection via `lingua`. `hotkey_suppression.rs` unregisters every shortcut while a named process is running — see below. `backup.rs` WebDAV/Aliyun/local config backup. `updater.rs` + `updater_window`. `error.rs` the one `thiserror` enum every command returns.

Application exceptions (`hotkey_suppression.rs`) are deliberately not "registered but ignored": the shortcut is genuinely unregistered, or the application it is supposed to be left for never receives the key. One worker polls `/proc`-equivalent process names through `sysinfo` (pinned to `=0.36.1` — 0.39 needs Rust 1.95), and sleeps on a condvar while the list is empty, so a user who configures nothing pays nothing. `hotkey.rs` owns the registration lock and a `HOTKEYS_SUSPENDED` flag: suppression, the settings page's unregister/register pair and a hotkey callback all take that lock or read that flag, because otherwise a save during a transition can leave a shortcut live while the monitor believes it is suspended. Restoration begins by unregistering everything, so a retry after a failed restore cannot stack duplicate handlers. A shortcut edited while suppressed is written to the store by the command itself — `useConfig` debounces, and the restore reads the store.

Windows are created hidden and shown once React mounts, so **anything that throws before `root.render` leaves an invisible window**. `main.jsx` therefore never lets init failures escape and mirrors the webview console into the Rust log (`attachConsole`) — check the log dir (tray → View Log) when a window fails to appear.

## Conventions

- Frontend is JSX with plain JS; `.ts` files are used only for data tables (`language.ts`, `info.ts`, `service_instance.ts`). No type-checking step runs.
- Import order in existing files is roughly longest-line-first; Prettier does not enforce it, so just match the surrounding file.
- **Hashing goes through `src/utils/crypto.js`** (`md5`, `sha256`, `hmacSha1`, `hmacSha256`, `toHex`, `toBase64`, `base64ToBytes`, `base64ToUtf8`), which wraps `@noble/hashes`. `crypto-js` is still a dependency for exactly one reason — `invoke_plugin.js` hands it to `.potext` plugins as published API — and nothing in the app's own code should import it. The wrappers absorb two differences that are silent rather than loud: noble takes bytes and throws on a string, and returns a `Uint8Array` where crypto-js's WordArray stringified to hex on its own. A third is in the signature — `hmacSha256(key, message)` takes the **key first**, where `CryptoJS.HmacSHA256` took the message first, so a mechanical rename at a call site would have signed the key with the message and still returned a plausible-looking digest.
- User-visible strings go through `react-i18next` (`t('...')`), keyed under `translation` in each locale file.
