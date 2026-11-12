"use strict";
const Path = require("node:path");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".eps": "application/postscript",
  ".ps": "application/postscript",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pfb": "application/x-font-type1",
  ".bcmap": "application/octet-stream",
  ".icc": "application/vnd.iccprofile",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".aff": "text/plain; charset=utf-8",
  ".dic": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".mp4": "video/mp4",
};

function mimeType(filename, fallback = "application/octet-stream") {
  return TYPES[Path.extname(filename).toLowerCase()] || fallback;
}

module.exports = { mimeType };
