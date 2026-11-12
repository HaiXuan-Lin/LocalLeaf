"use strict";
const Path = require("node:path");
const { pathToFileURL } = require("node:url");
const { vendoredPath, REPO_ROOT } = require("../util/vendor");

/**
 * Labels, packages and document class of the project's docs, used by the
 * editor's autocomplete (\ref{...}, commands of loaded packages).
 *
 * Ported from Overleaf's web service
 * (services/web/app/src/Features/Metadata/MetaHandler.mjs).
 */

const LABEL_RE = /\\label{(.{0,80}?)}/g;
const LABEL_OPTION_RE = /\blabel={?(.{0,80}?)[\s},\]]/g;
const PACKAGE_RE = /^\\usepackage(?:\[.{0,80}?])?{(.{0,80}?)}/g;
const REQ_PACKAGE_RE = /^\\RequirePackage(?:\[.{0,80}?])?{(.{0,80}?)}/g;
const DOCUMENT_CLASS_RE = /^\\documentclass(?:\[.{0,80}?])?{(.{0,80}?)}/;

let packageMappingPromise = null;

/** Overleaf's table of the commands each LaTeX package provides. */
function loadPackageMapping() {
  if (!packageMappingPromise) {
    packageMappingPromise = (async () => {
      const staged = vendoredPath("package-mapping.json");
      if (staged) return require(staged);
      // Running from a source checkout: read Overleaf's module directly.
      const source = Path.join(
        REPO_ROOT,
        "services/web/app/src/Features/Metadata/packageMapping.mjs",
      );
      const module = await import(pathToFileURL(source).href);
      return module.default;
    })().catch(() => ({}));
  }
  return packageMappingPromise;
}

function getNonCommentedContent(rawLine) {
  return rawLine.replace(/(^|[^\\])%.*/, "$1");
}

function* lineMatches(matchRe, line, separator) {
  matchRe.lastIndex = 0;
  let match;
  while ((match = matchRe.exec(line))) {
    const matched = match[1].trim();
    if (!matched) continue;
    if (separator) {
      for (const item of matched.split(",")) {
        if (item.trim()) yield item.trim();
      }
    } else {
      yield matched;
    }
  }
}

async function extractMetaFromDoc(content) {
  const packageMapping = await loadPackageMapping();
  const docMeta = {
    labels: [],
    packages: {},
    packageNames: [],
    documentClass: null,
  };
  for (const rawLine of content.split("\n")) {
    const line = getNonCommentedContent(rawLine);
    for (const label of lineMatches(LABEL_RE, line)) docMeta.labels.push(label);
    for (const label of lineMatches(LABEL_OPTION_RE, line)) {
      docMeta.labels.push(label);
    }
    for (const pkg of lineMatches(PACKAGE_RE, line, ",")) {
      docMeta.packageNames.push(pkg);
    }
    for (const pkg of lineMatches(REQ_PACKAGE_RE, line, ",")) {
      docMeta.packageNames.push(pkg);
    }
    if (docMeta.documentClass == null) {
      const match = line.match(DOCUMENT_CLASS_RE);
      if (match != null) docMeta.documentClass = match[1];
    }
  }
  for (const packageName of docMeta.packageNames) {
    if (Object.prototype.hasOwnProperty.call(packageMapping, packageName)) {
      docMeta.packages[packageName] = packageMapping[packageName];
    }
  }
  return docMeta;
}

// Only LaTeX sources can contribute labels and packages.
const META_EXTENSIONS = new Set([
  ".tex",
  ".ltx",
  ".sty",
  ".cls",
  ".rtex",
  ".rnw",
  ".tikz",
  ".def",
]);

function hasMetadata(name) {
  return META_EXTENSIONS.has(Path.extname(name).toLowerCase());
}

module.exports = { extractMetaFromDoc, hasMetadata, loadPackageMapping };
