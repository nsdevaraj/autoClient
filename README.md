# AutoDraw Client

Demo https://nsdevaraj.github.io/autoClient/
A standalone AutoDraw web client: sketch on the canvas, and the app recognises the drawing
in the browser and offers matching icons that replace the sketch. Everything runs locally —
the ONNX models, the icon retrieval index and the static server are all in this folder.

## Run it

```sh
npm start            # http://127.0.0.1:4173/
npm start -- --port 8080 --host 0.0.0.0
npm test             # node --test
```

No install step and no dependencies: the ONNX Runtime Web build is vendored in `vendor/`.
Node 20+ is required.

### Serving it another way

Any static file server works, as long as it serves **this folder** as the site root, so that
`index.html`, `src/`, `vendor/`, `models/` and `data/` sit next to each other:

```sh
npx http-server . -p 8080 -c-1     # or: python3 -m http.server 8080
```

All asset URLs are resolved relative to the app folder, so mounting the app under a sub-path
(`https://example.com/autodraw/`) works too.

Two caveats when not using `npm start`:

- `/svgdepot/` (the icon proxy) does not exist, so icons load from their commit-pinned
  jsDelivr URLs, which is what the app does by default anyway.
- Serving the *parent* of this folder, or a folder without `vendor/`, makes the ONNX runtime
  404. The app then reports **“Runtime unavailable”** with the failing URL instead of hanging
  on “Loading model”.

## How it works

1. Strokes are collected on a canvas and normalised into polylines.
2. `sketch-embedder` (ONNX) embeds the sketch into a 128-d unit vector.
3. The embedding is scored against the shard-based icon index in `data/icon-embeddings/`,
   and the closest icons become suggestions.
4. If the embedder or the index cannot load, the app falls back to the `quickdraw-mvp`
   classifier plus the approved candidate manifest (`data/quickdraw-candidates.json`).
5. Picking a suggestion replaces the strokes with the icon; the result can be exported as SVG.

Icons themselves are not bundled. By default the browser loads each icon straight from its
**commit-pinned jsDelivr URL** — the approved URL the index derives — so icons work under any
static server and need public network access.

Because jsDelivr refuses to serve a GitHub package larger than 50 MB and the corpus is ~511 MB
across ~210k icons, the icons are published as several sub-50 MB repositories rather than one.
The repository holding a path is derived from the path itself (`src/icon-shards.mjs`), so no
lookup table ships with the client and the split is reproducible. `data/quickdraw-candidates.json`
and `data/icon-embeddings/index.json` list the pinned shard repositories under `source.shards`;
a manifest without that list still resolves against its single `source.repository`.

Each shard is referenced by an immutable **release tag** (`v1.0.0`), because jsDelivr resolves a
GitHub package by released version — an untagged repository is unreachable even when it is well
under the size limit, and branch or bare-commit references are not served. The commit is still
recorded next to the tag as provenance, and only a 40-character commit or a `vX.Y.Z` tag is ever
accepted as a pin, so a mutable reference such as `@main` can never be approved.

Use `scripts/build-icon-shard-repos.mjs` to rebuild the split:

```sh
node scripts/build-icon-shard-repos.mjs                    # materialise the trees only
node scripts/build-icon-shard-repos.mjs --publish          # also create the repos and push
node scripts/build-icon-shard-repos.mjs --apply            # repoint the manifests at the pins
```

The server also exposes `/svgdepot/<path>`, which serves an optional local cache
(`.cache/svgdepot/`) and otherwise proxies the same pinned URL. Add `?icons=local` to the page
URL to prefer that route, which keeps icon traffic same-origin (and fully offline when the
cache is populated). Either way, if the chosen source fails the app falls back to the other one
and remembers that choice for the rest of the session.

## Layout

| Path | Purpose |
| --- | --- |
| `index.html` | The whole UI: toolbar, suggestion rail, canvas, style dock |
| `src/boot.mjs` | Loads the app and reports module-load failures in the UI |
| `src/drawing-app.mjs` | App entry point: input, rendering, recognition, export |
| `src/drawing-state.mjs` | Immutable drawing state with undo/redo, resize, icon placement |
| `src/drawing-export.mjs` | SVG export with embedded icon data URLs |
| `src/autodraw-suggestions.mjs` | Retrieval and candidate suggestion sources |
| `src/sketch-embedder.mjs` | ONNX sketch encoder wrapper |
| `src/quickdraw-classifier.mjs` | ONNX Quick Draw classifier wrapper (fallback) |
| `src/sketch-rasterizer.mjs` | Polyline/stroke-3 normalisation and rasterisation |
| `src/icon-retrieval.mjs` | Shard loading, hash checks and nearest-neighbour search |
| `src/icon-candidate.mjs` | Approval rules for commit-pinned icon URLs and paths |
| `src/icon-shards.mjs` | Derives which pinned repository holds an icon path |
| `src/icon-proxy.mjs` | Size-bounded, cached SVG proxy for approved icons |
| `src/static-server.mjs` | Allowlisted static handler plus the `/svgdepot/` route |
| `scripts/serve.mjs` | CLI wrapper around the static handler |
| `scripts/build-icon-shard-repos.mjs` | Splits the icon corpus into sub-50 MB repositories |

## Model files

| File | Size | Role |
| --- | --- | --- |
| `models/sketch-embedder/sketch-embedder.onnx` | ~2 MB | Sketch encoder used for retrieval |
| `models/sketch-embedder/model.json` | ~6 KB | Input/output contract, classes, embedding dim |
| `models/quickdraw-mvp/quickdraw-mvp.onnx` | ~2 MB | Quick Draw classifier used as fallback |
| `models/quickdraw-mvp/model.json` | ~17 KB | Class list and tensor contract |
| `data/icon-embeddings/` | ~34 MB | int8 icon vectors, sharded with SHA-256 manifests |
| `data/quickdraw-candidates.json` | ~2 MB | Approved icon candidates per class |

Both model wrappers verify the metadata contract (tensor names, shapes, class lists) before
running inference, and the retrieval index verifies every shard hash it loads.

The ONNX Runtime bundle in `vendor/` ships without its source map, so the trailing
`//# sourceMappingURL=ort.wasm.min.mjs.map` comment is stripped from `ort.wasm.min.mjs`. Leaving
it in makes every browser with developer tools open request a file that was never vendored. Strip
it again when re-vendoring the runtime, or vendor the matching `.map` alongside it.

## Security notes

- The server only serves an explicit allowlist of routes and rejects anything resolving
  outside the project root, including through symlinks.
- Icon paths must be confined relative `.svg` paths, and proxied URLs must match the
  commit-pinned jsDelivr URL derived from the manifest source.
- Responses carry a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`), `nosniff`
  and `no-store`.
