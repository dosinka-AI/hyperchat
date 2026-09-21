#!/usr/bin/env bash
# Build HyperChat as ONE downloadable html file.
#
# The exact same client code (components, store, sounds, markdown, catalog)
# bundled by bun into an IIFE, the complete Tailwind stylesheet compiled by
# the v4 CLI, and the click/send/message/join sounds inlined as data urls.
# The in-page backend (standalone/backend.ts) answers every /api/* call and
# a BroadcastChannel stands in for the socket, so the whole app works
# straight from the file: login screen first, no landing page.
set -euo pipefail

ROOT="/home/z/my-project"
OUT="$ROOT/download/hyperchat-standalone.html"
BUILD="$ROOT/.standalone-build"
mkdir -p "$BUILD" "$ROOT/download"

echo "==> 1/5 compiling the full stylesheet (tailwind v4 cli)"
bunx @tailwindcss/cli -i "$ROOT/src/app/globals.css" -o "$BUILD/app.css" --minify 2>/dev/null || \
  bunx @tailwindcss/cli -i "$ROOT/src/app/globals.css" -o "$BUILD/app.css"

echo "==> 2/5 bundling the app (bun build iife)"
bun build "$ROOT/standalone/entry.tsx" \
  --format=iife \
  --target=browser \
  --outfile="$BUILD/app.js" \
  --minify

echo "==> 3/5 inlining sounds as data urls"
node -e '
const fs = require("fs")
const sounds = {
  "/sounds/ui-light-tick-sound.wav": "click",
  "/sounds/ui-mid-tick-sound.wav": "send",
  "/sounds/message-sound-louder.wav": "msg",
  "/sounds/join.wav": "join",
}
const map = {}
for (const [path, _name] of Object.entries(sounds)) {
  const buf = fs.readFileSync("/home/z/my-project/public" + path)
  map[path] = "data:audio/wav;base64," + buf.toString("base64")
}
fs.writeFileSync("/home/z/my-project/.standalone-build/sounds.js",
  "window.__HYPERCHAT_SOUNDS=" + JSON.stringify(map) + ";")
'

echo "==> 4/5 assembling the single file"
node -e '
const fs = require("fs")
const css = fs.readFileSync("/home/z/my-project/.standalone-build/app.css", "utf8")
// the bundle contains literal "</script>" strings (react error messages):
// escape them so the inline script element never terminates early
const raw = fs.readFileSync("/home/z/my-project/.standalone-build/app.js", "utf8")
const js = raw.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--")
const sounds = fs.readFileSync("/home/z/my-project/.standalone-build/sounds.js", "utf8")
const html = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="dark"/>
<title>HyperChat</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,400..900;1,400..900&display=swap" rel="stylesheet"/>
<style>
:root { --font-archivo: "Archivo", ui-sans-serif, system-ui, sans-serif; }
html, body { margin: 0; padding: 0; background: #000; }
${css}
</style>
<script>${sounds}</script>
</head>
<body>
<div id="__hyperchat_root"></div>
<noscript>hyperchat needs javascript.</noscript>
<script>${js}</script>
</body>
</html>`
fs.writeFileSync("/home/z/my-project/download/hyperchat-standalone.html", html)
console.log("wrote", (html.length / 1024 / 1024).toFixed(2), "MB")
'

echo "==> 5/5 done: $OUT"
ls -la "$OUT"
