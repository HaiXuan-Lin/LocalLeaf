#!/usr/bin/env node
"use strict";
/*
 * Turns desktop/build/app into desktop/dist/<Name>.app using the Electron
 * runtime from desktop/node_modules.
 *
 * Usage: node desktop/scripts/package-app.js [--arch=arm64|x64|universal]
 *                                            [--platform=darwin]
 */
const fs = require("node:fs");
const Path = require("node:path");

const DESKTOP_DIR = Path.join(__dirname, "..");
const APP_DIR = Path.join(DESKTOP_DIR, "build", "app");
const OUT_DIR = Path.join(DESKTOP_DIR, "build", "package");
const DIST_DIR = Path.join(DESKTOP_DIR, "dist");

// Interface languages of the editor; other Chromium locales are removed.
const KEPT_LOCALES = new Set([
  "en",
  "en_GB",
  "zh_CN",
  "zh_TW",
  "cs",
  "da",
  "de",
  "es",
  "fi",
  "fr",
  "it",
  "ja",
  "ko",
  "nl",
  "nb",
  "pl",
  "pt_BR",
  "pt_PT",
  "ru",
  "sv",
  "tr",
]);

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function pruneLocales(appPath) {
  const resources = Path.join(
    appPath,
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources",
  );
  if (!fs.existsSync(resources)) return;
  for (const name of fs.readdirSync(resources)) {
    if (name.endsWith(".lproj") && !KEPT_LOCALES.has(name.slice(0, -6))) {
      fs.rmSync(Path.join(resources, name), { recursive: true, force: true });
    }
  }
}

async function main() {
  const pkg = JSON.parse(
    fs.readFileSync(Path.join(DESKTOP_DIR, "package.json"), "utf8"),
  );
  const electronVersion = JSON.parse(
    fs.readFileSync(
      Path.join(DESKTOP_DIR, "node_modules/electron/package.json"),
      "utf8",
    ),
  ).version;
  const platform = argument("platform", "darwin");
  const arch = argument("arch", process.arch === "x64" ? "x64" : "arm64");
  const icon = Path.join(DESKTOP_DIR, "build", "icon.icns");

  // @electron/packager is an ES module
  const { packager } = await import("@electron/packager");
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const [packagedDir] = await packager({
    dir: APP_DIR,
    out: OUT_DIR,
    name: pkg.productName,
    platform,
    arch,
    electronVersion,
    appVersion: pkg.version,
    appBundleId: pkg.localleaf.bundleId,
    appCategoryType: "public.app-category.productivity",
    appCopyright:
      "Based on Overleaf, (c) Overleaf and contributors. GNU AGPL v3.",
    icon: fs.existsSync(icon) ? icon : undefined,
    // Plain files instead of an asar archive: easy to inspect and patch.
    asar: false,
    prune: false,
    overwrite: true,
    quiet: true,
    darwinDarkModeSupport: true,
    extendInfo: {
      // Folders can be dropped on the Dock icon or opened with `open -a`.
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "Folder",
          CFBundleTypeRole: "Editor",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: ["public.folder"],
        },
        {
          CFBundleTypeName: "LaTeX document",
          CFBundleTypeRole: "Editor",
          LSHandlerRank: "Alternate",
          CFBundleTypeExtensions: ["tex", "ltx", "bib", "sty", "cls"],
        },
      ],
      NSHumanReadableCopyright:
        "Based on Overleaf, © Overleaf and contributors. GNU AGPL v3.",
    },
  });

  let result = packagedDir;
  if (platform === "darwin") {
    const appPath = Path.join(packagedDir, `${pkg.productName}.app`);
    pruneLocales(appPath);
    fs.mkdirSync(DIST_DIR, { recursive: true });
    result = Path.join(DIST_DIR, `${pkg.productName}.app`);
    fs.rmSync(result, { recursive: true, force: true });
    // rename keeps the symlinks inside the frameworks intact
    fs.renameSync(appPath, result);
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  console.log(result);
}

// Node exits quietly with status 0 when a promise never settles (seen with an
// unzip library that stalls on newer Node versions). Never let that pass for
// a finished package.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error(
      `error: packaging stopped before it finished (Node ${process.version}).`,
    );
    process.exitCode = 1;
  }
});

main().then(
  () => {
    finished = true;
  },
  (error) => {
    finished = true;
    console.error(error.stack || error);
    process.exitCode = 1;
  },
);
