"use strict";
const fs = require("node:fs");
const Path = require("node:path");

/**
 * A few plain-JS files from the Overleaf services are reused unchanged by the
 * desktop backend (the OT text type, the list of editable extensions, ...).
 *
 * In a packaged app they live in `vendor/` (copied there by
 * desktop/scripts/stage-app.js). When running from a source checkout they are
 * loaded straight from where they live in the monorepo.
 */
const APP_ROOT = Path.join(__dirname, "..", "..");
const REPO_ROOT = Path.join(APP_ROOT, "..");

const SOURCES = {
  "text_file_defaults.js":
    "libraries/overleaf-editor-core/lib/text_file_defaults.js",
  "sharejs/text.js": "services/document-updater/app/js/sharejs/types/text.js",
  "sharejs/helpers.js":
    "services/document-updater/app/js/sharejs/types/helpers.js",
  "package-mapping.json": null, // generated at build time, see stage-app.js
};

function vendoredPath(name) {
  const staged = Path.join(APP_ROOT, "vendor", name);
  if (fs.existsSync(staged)) return staged;
  const source = SOURCES[name];
  if (source) {
    const inRepo = Path.join(REPO_ROOT, source);
    if (fs.existsSync(inRepo)) return inRepo;
  }
  return null;
}

function requireVendored(name) {
  const path = vendoredPath(name);
  if (!path) {
    throw new Error(`missing vendored file: ${name}`);
  }
  return require(path);
}

module.exports = {
  APP_ROOT,
  REPO_ROOT,
  SOURCES,
  vendoredPath,
  requireVendored,
};
