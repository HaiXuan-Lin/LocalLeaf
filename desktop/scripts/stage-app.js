#!/usr/bin/env node
"use strict";
/*
 * Assembles the folder that becomes the app's code (Contents/Resources/app):
 *
 *   desktop/build/app/
 *     package.json          trimmed copy of desktop/package.json
 *     main/ preload/ shims/ the Electron side, copied as is
 *     vendor/               plain-JS files reused from the Overleaf services
 *     renderer/             the editor front end (written by webpack earlier)
 *
 * Usage: node desktop/scripts/stage-app.js
 */
const fs = require("node:fs");
const Path = require("node:path");
const { pathToFileURL } = require("node:url");

const DESKTOP_DIR = Path.join(__dirname, "..");
const REPO_DIR = Path.join(DESKTOP_DIR, "..");
const APP_DIR = Path.join(DESKTOP_DIR, "build", "app");
const RENDERER_DIR = Path.join(APP_DIR, "renderer");

function copyDir(name) {
  const target = Path.join(APP_DIR, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(Path.join(DESKTOP_DIR, name), target, { recursive: true });
}

function copyFile(from, to) {
  fs.mkdirSync(Path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Source maps are a by-product of the build; the app does not ship them. */
function removeSourceMaps(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = Path.join(dir, entry.name);
    if (entry.isDirectory()) removeSourceMaps(path);
    else if (entry.name.endsWith(".map")) fs.rmSync(path);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = Path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(path) : fs.statSync(path).size;
  }
  return total;
}

async function main() {
  for (const required of ["manifest.json", "desktop-config.json"]) {
    if (!fs.existsSync(Path.join(RENDERER_DIR, required))) {
      throw new Error(
        `${Path.join(RENDERER_DIR, required)} is missing: build the editor front end first (./build.sh does both).`,
      );
    }
  }

  removeSourceMaps(RENDERER_DIR);

  copyDir("main");
  copyDir("preload");
  copyDir("shims");

  const pkg = JSON.parse(
    fs.readFileSync(Path.join(DESKTOP_DIR, "package.json"), "utf8"),
  );
  fs.writeFileSync(
    Path.join(APP_DIR, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        productName: pkg.productName,
        version: pkg.version,
        description: pkg.description,
        license: pkg.license,
        main: pkg.main,
      },
      null,
      2,
    ) + "\n",
  );

  // Files of the Overleaf services that the local backend runs unchanged.
  // The list lives next to the code that loads them.
  const { SOURCES } = require(Path.join(DESKTOP_DIR, "main/util/vendor.js"));
  const vendorDir = Path.join(APP_DIR, "vendor");
  fs.rmSync(vendorDir, { recursive: true, force: true });
  for (const [name, source] of Object.entries(SOURCES)) {
    if (source)
      copyFile(Path.join(REPO_DIR, source), Path.join(vendorDir, name));
  }

  // Overleaf's table "LaTeX package -> commands it provides" (autocomplete),
  // converted from an ES module to JSON for the main process.
  const mapping = await import(
    pathToFileURL(
      Path.join(
        REPO_DIR,
        "services/web/app/src/Features/Metadata/packageMapping.mjs",
      ),
    ).href
  );
  fs.writeFileSync(
    Path.join(vendorDir, "package-mapping.json"),
    JSON.stringify(mapping.default),
  );

  copyFile(Path.join(REPO_DIR, "LICENSE"), Path.join(APP_DIR, "LICENSE"));

  const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";
  console.log(`staged ${APP_DIR}`);
  console.log(`  editor front end: ${megabytes(dirSize(RENDERER_DIR))}`);
  console.log(`  total:            ${megabytes(dirSize(APP_DIR))}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
