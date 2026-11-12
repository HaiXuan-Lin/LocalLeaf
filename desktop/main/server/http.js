"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Path = require("node:path");
const { Readable } = require("node:stream");
const { mimeType } = require("../util/mime");

const NO_STORE = { "Cache-Control": "no-store" };
const STREAM_THRESHOLD = 16 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE },
  });
}

function noContent() {
  return new Response(null, { status: 204, headers: NO_STORE });
}

function text(body, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, ...NO_STORE },
  });
}

function notFound(message = "Not Found") {
  return text(message, 404);
}

function contentDisposition(filename) {
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Serve a file from disk, honouring Range requests (the PDF viewer asks for
 * the PDF in chunks).
 *
 * @param {string} absPath
 * @param {Request} request
 * @param {object} [options]
 * @param {string} [options.contentType]
 * @param {boolean} [options.immutable] content-hashed build asset
 * @param {string} [options.downloadName] send as an attachment
 */
async function serveFile(absPath, request, options = {}) {
  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();

  const headers = {
    "Content-Type": options.contentType || mimeType(absPath),
    "Accept-Ranges": "bytes",
    "Cache-Control": options.immutable
      ? "public, max-age=31536000, immutable"
      : "no-store",
  };
  if (options.downloadName) {
    headers["Content-Disposition"] = contentDisposition(options.downloadName);
  }

  const size = stat.size;
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = request.headers.get("range");
  if (range && size > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] || match[2])) {
      if (match[1]) {
        start = parseInt(match[1], 10);
        if (match[2]) end = Math.min(parseInt(match[2], 10), size - 1);
      } else {
        // suffix range: the last N bytes
        start = Math.max(0, size - parseInt(match[2], 10));
      }
      if (start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}`, ...NO_STORE },
        });
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
  }
  const length = size === 0 ? 0 : end - start + 1;
  headers["Content-Length"] = String(length);

  if (request.method === "HEAD" || length === 0) {
    return new Response(null, { status, headers });
  }
  if (length <= STREAM_THRESHOLD) {
    const handle = await fsp.open(absPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return new Response(buffer, { status, headers });
    } finally {
      await handle.close();
    }
  }
  const stream = fs.createReadStream(absPath, { start, end });
  return new Response(Readable.toWeb(stream), { status, headers });
}

/** Resolve `relPath` below `rootDir`, refusing to escape it. */
function safeJoin(rootDir, relPath) {
  const resolved = Path.resolve(rootDir, "." + Path.sep + relPath);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + Path.sep)) {
    return null;
  }
  return resolved;
}

module.exports = {
  json,
  noContent,
  text,
  notFound,
  serveFile,
  safeJoin,
  contentDisposition,
};
