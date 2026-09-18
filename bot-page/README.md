# bot-page

`webex.min.js` is vendored at image build time from the `webex` npm package's UMD bundle, not fetched from any CDN at runtime. It is pinned via `frontend/package.json` (`webex: ^3.12.0`) and copied into this directory by the Dockerfile's frontend build stage:

```
node_modules/webex/umd/webex.min.js -> /app/bot-page/webex.min.js
```

This path was verified locally (2026-07-22) against the installed `webex@3.12.0` package: `node_modules/webex/umd/` contains `webex.min.js` (a self-contained webpack UMD bundle, ~3.9 MB minified, exposing the global `Webex` — `window.Webex`) alongside sibling bundles (`calling.min.js`, `meetings.min.js`, `encryption.min.js`) that are not used here. The package's `package.json` has no `browser`/`umd`/`unpkg` manifest field pointing at this file — the `umd/` directory convention is undocumented but stable across the `3.x` line. If a future `webex` version moves or renames this bundle, update the `cp` line in the Dockerfile's frontend stage accordingly (re-verify with `find node_modules/webex -maxdepth 3 -name "*.min.js"` after `npm install`).

`botPageCore.js` (compiled from `backend/src/media/botPageCore.ts`, standalone, no project imports) is emitted next to `bot.js` and `webex.min.js` by the Dockerfile's backend build stage (`npx tsc ... --module es2022 --target es2022 --moduleResolution bundler`), so `bot.js`'s `import './botPageCore.js'` resolves as a plain ES module in the browser at runtime.
