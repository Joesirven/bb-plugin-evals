# bb-plugin-evals

A BB plugin.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required); optional `bb.app` for a frontend.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — supported plugin SDK range (scaffold: `^0.4.1`).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` (and, with `bb.app`, `app.js` /
`app.css` / `app.meta.json`). Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Install

From this directory:

```
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload evals
```

## Configure

```
bb plugin config evals
bb plugin config evals set greeting hi
```

## Types & API reference

`types/bb-plugin-sdk.d.ts` (and `types/bb-plugin-sdk-app.d.ts` for the
frontend) are the full, bundled BB plugin API — `tsconfig.json` maps
`@bb/plugin-sdk` to them, so your editor and `tsc` see real types with no extra
install. Ask BB to write plugins for you: the `bb-plugin-authoring` skill
documents the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/ymichael/bb>.
