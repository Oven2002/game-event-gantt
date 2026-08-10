# Building the vendored Live2D widget

This fork keeps the Cubism renderer chunks independent from the widget entry. Both
Cubism 2 and Cubism 5 import the stable `chunk/logger.js` module; they must never
import `waifu-tips.js`.

For normal changes under `src/`, run this command from the repository root:

```sh
npm run build:live2d
```

It compiles TypeScript, bundles only the widget runtime, treats the already-built
Cubism chunks as external modules, and copies the changed runtime artifacts into
`public/vendor/live2d-widget/dist/`.

The repository declares this directory as an npm workspace, so a root-level
`npm ci` installs the required Rollup, terser, and TypeScript build tools.
`build:runtime` uses `tsconfig.runtime.json` and does not regenerate declaration
files; this preserves the Cubism SDK-backed declarations already checked in.

The regular `npm run build` intentionally does not rebuild this vendored code.
After rebuilding it, run `npm test` and `npm run build` before committing.

## Full Cubism rebuild

`npm run build` inside this directory is only for an SDK upgrade. It requires an
official Cubism SDK for Web directory at the path expected by
`rollup.config.js` (`build/CubismSdkForWeb-*`). A full build regenerates
`chunk/index.js`, `chunk/index2.js`, and `chunk/logger.js`; copy those files and
their source maps into the matching public directory afterward. The SDK source
must also be available at the `tsconfig.json` path mappings if you intend to
regenerate declaration files; otherwise use `build:runtime`, which deliberately
leaves the checked-in declarations untouched.

Do not replace `manualChunks`, enable minified internal export names, or make a
Cubism chunk import the entry module. Those changes can create a circular module
graph whose failure mode is a visible dialogue box with a transparent canvas.
