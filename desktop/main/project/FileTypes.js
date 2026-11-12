"use strict";
const Path = require("node:path");
const { isUtf8 } = require("node:buffer");
const { requireVendored } = require("../util/vendor");

// The lists Overleaf itself uses to decide what is an editable doc.
const {
  DEFAULT_TEXT_EXTENSIONS,
  DEFAULT_EDITABLE_FILENAMES,
  DEFAULT_ROOT_DOC_EXTENSIONS,
} = requireVendored("text_file_defaults.js");

// Extra plain-text formats that commonly sit next to LaTeX sources in a local
// folder. Overleaf's list is tuned for uploads; a desktop editor sees more.
const EXTRA_TEXT_EXTENSIONS = [
  "bbl",
  "bash",
  "c",
  "cpp",
  "css",
  "csv",
  "dat",
  "gitignore",
  "gnuplot",
  "gp",
  "h",
  "html",
  "ini",
  "jl",
  "js",
  "json",
  "makefile",
  "nb",
  "pgf",
  "r",
  "sh",
  "toml",
  "tsv",
  "xml",
  "zsh",
];

const TEXT_EXTENSIONS = [
  ...new Set([...DEFAULT_TEXT_EXTENSIONS, ...EXTRA_TEXT_EXTENSIONS]),
];
const EDITABLE_FILENAMES = [
  ...new Set([
    ...DEFAULT_EDITABLE_FILENAMES,
    "readme",
    "license",
    ".gitignore",
  ]),
];
const ROOT_DOC_EXTENSIONS = [...DEFAULT_ROOT_DOC_EXTENSIONS];

// Same limit as Overleaf (Settings.max_doc_length): larger files are shown as
// read-only files instead of being opened in the editor.
const MAX_DOC_LENGTH = 2 * 1024 * 1024;

const TEXT_EXTENSION_SET = new Set(TEXT_EXTENSIONS.map((ext) => `.${ext}`));

// Directories that are never part of a project.
const IGNORED_DIRECTORIES = new Set([
  "__MACOSX",
  ".git",
  ".hg",
  ".svn",
  ".texpadtmp",
  ".R",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
]);

// Hidden files that are still useful to see and edit.
const VISIBLE_DOTFILES = new Set([".latexmkrc", ".gitignore"]);

// By-products of an in-place LaTeX build. They stay on disk (latexmk needs
// them) but are kept out of the file tree, like TeXstudio's "auxiliary files".
const BUILD_ARTIFACT_SUFFIXES = [
  ".acn",
  ".acr",
  ".alg",
  ".aux",
  ".bcf",
  ".blg",
  ".dvi",
  ".fdb_latexmk",
  ".fls",
  ".glg",
  ".glo",
  ".gls",
  ".glsdefs",
  ".idx",
  ".ilg",
  ".ind",
  ".lof",
  ".log",
  ".lol",
  ".lot",
  ".maf",
  ".nav",
  ".nlo",
  ".nls",
  ".out",
  ".pdfsync",
  ".run.xml",
  ".snm",
  ".spl",
  ".swp",
  ".synctex",
  ".synctex(busy)",
  ".synctex.gz",
  ".synctex.gz(busy)",
  ".tdo",
  ".thm",
  ".toc",
  ".vrb",
  ".xdv",
];

function isIgnoredDirectory(name) {
  return IGNORED_DIRECTORIES.has(name) || name.startsWith(".");
}

function isBuildArtifact(name) {
  const lower = name.toLowerCase();
  return BUILD_ARTIFACT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isIgnoredFile(name, { showBuildArtifacts = false } = {}) {
  if (name.startsWith(".")) {
    return !VISIBLE_DOTFILES.has(name);
  }
  if (name.endsWith("~")) {
    return true;
  }
  if (!showBuildArtifacts && isBuildArtifact(name)) {
    return true;
  }
  return false;
}

function isTextFilename(name) {
  const lower = name.toLowerCase();
  return (
    TEXT_EXTENSION_SET.has(Path.extname(lower)) ||
    EDITABLE_FILENAMES.includes(lower)
  );
}

/**
 * Can this decoded text be edited as an Overleaf doc?
 *
 * Follows overleaf-editor-core/lib/file_type_detector.js, minus its rule
 * against characters outside the Basic Multilingual Plane: that rule protects
 * Overleaf's history service, which the desktop app does not have. Here both
 * ends of the OT pipeline are JavaScript strings, so such characters are safe.
 */
function isEditableString(content) {
  if (content.length >= MAX_DOC_LENGTH) return false;
  if (content.includes("\u0000")) return false;
  return true;
}

const SNIFF_BYTES = 64 * 1024;

/**
 * Does this (possibly truncated) buffer look like UTF-8 text?
 * A truncated read may end in the middle of a multi-byte character.
 */
function looksLikeUtf8Text(buffer, truncated) {
  if (buffer.includes(0)) return false;
  if (isUtf8(buffer)) return true;
  if (!truncated) return false;
  for (let cut = 1; cut <= 3 && cut < buffer.length; cut++) {
    if (isUtf8(buffer.subarray(0, buffer.length - cut))) return true;
  }
  return false;
}

/**
 * Decide whether a file on disk is an editable doc or a (read-only) file.
 *
 * Only the name, the size and the first bytes are looked at, so that opening
 * a folder with many or large files stays fast. The full content is checked
 * when the file is opened in the editor.
 *
 * @param {string} name
 * @param {number} size
 * @param {(maxBytes: number) => Buffer} readHead called only when needed
 * @return {'doc' | 'file'}
 */
function classify(name, size, readHead) {
  if (!isTextFilename(name)) return "file";
  if (size > 3 * MAX_DOC_LENGTH) return "file";
  if (size === 0) return "doc";
  let head;
  try {
    head = readHead(SNIFF_BYTES);
  } catch {
    return "file";
  }
  return looksLikeUtf8Text(head, size > head.length) ? "doc" : "file";
}

const VALID_NAME_MAX_LENGTH = 150;
// eslint-disable-next-line no-control-regex
const BAD_NAME_CHARS = /[/\\*\u0000-\u001F\u007F\uD800-\uDFFF]/;

/** Same spirit as Overleaf's SafePath.isCleanFilename. */
function isCleanFilename(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= VALID_NAME_MAX_LENGTH &&
    name !== "." &&
    name !== ".." &&
    !BAD_NAME_CHARS.test(name) &&
    name === name.trim()
  );
}

module.exports = {
  TEXT_EXTENSIONS,
  EDITABLE_FILENAMES,
  ROOT_DOC_EXTENSIONS,
  MAX_DOC_LENGTH,
  SNIFF_BYTES,
  classify,
  isBuildArtifact,
  isCleanFilename,
  isEditableString,
  isIgnoredDirectory,
  isIgnoredFile,
  isTextFilename,
};
