"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const Path = require("node:path");
const { execFile } = require("node:child_process");
const { HttpError } = require("../util/errors");
const { json, noContent, text, notFound, serveFile } = require("./http");
const Synctex = require("../project/Synctex");
const FileTypes = require("../project/FileTypes");

/**
 * The HTTP API of Overleaf's web service, reduced to what the editor needs
 * for a single local user and backed by the opened folder.
 *
 * Each handler receives ({ session, params, query, request, app }) and
 * returns a Response.
 */

const ID = "[0-9a-f]{24}";
const BUILD = "[0-9a-f-]+";

const routes = [];

function route(method, pattern, handler) {
  const names = [];
  const source = pattern.replace(
    /:([a-zA-Z]+)(\(([^)]+)\))?/g,
    (_m, name, _g, custom) => {
      names.push(name);
      if (custom) return `(${custom})`;
      if (name === "projectId" || name.endsWith("Id")) return `(${ID})`;
      return "([^/]+)";
    },
  );
  routes.push({ method, regex: new RegExp(`^${source}$`), names, handler });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function requireNode(session, id, types) {
  const node = session.tree.getNode(id);
  if (
    !node ||
    node === session.tree.root ||
    (types && !types.includes(node.type))
  ) {
    throw new HttpError(404, "not found");
  }
  return node;
}

// ------------------------------------------------------------------ file tree

route("POST", "/project/:projectId/doc", async ({ session, request }) => {
  const body = await readJson(request);
  const parentId = body.parent_folder_id || session.tree.root.id;
  return json(await session.tree.createDoc(parentId, body.name));
});

route("POST", "/project/:projectId/folder", async ({ session, request }) => {
  const body = await readJson(request);
  const parentId = body.parent_folder_id || session.tree.root.id;
  return json(await session.tree.createFolder(parentId, body.name));
});

route(
  "POST",
  "/project/:projectId/:type(doc|file|folder)/:entityId/rename",
  async ({ session, params, request }) => {
    const body = await readJson(request);
    requireNode(session, params.entityId);
    await session.tree.rename(params.entityId, body.name);
    return noContent();
  },
);

route(
  "POST",
  "/project/:projectId/:type(doc|file|folder)/:entityId/move",
  async ({ session, params, request }) => {
    const body = await readJson(request);
    requireNode(session, params.entityId);
    await session.tree.move(params.entityId, body.folder_id);
    return noContent();
  },
);

route(
  "DELETE",
  "/project/:projectId/:type(doc|file|folder)/:entityId",
  async ({ session, params }) => {
    requireNode(session, params.entityId);
    await session.tree.delete(params.entityId);
    return noContent();
  },
);

route(
  "POST",
  "/project/:projectId/upload",
  async ({ session, query, request }) => {
    let form;
    try {
      form = await request.formData();
    } catch (error) {
      throw new HttpError(400, `could not read upload: ${error.message}`);
    }
    const file = form.get("qqfile");
    if (!file || typeof file.arrayBuffer !== "function") {
      throw new HttpError(400, "no file in upload");
    }
    const name = String(form.get("name") || file.name || "").trim();
    const relativePath = String(form.get("relativePath") || "");
    let folderId = query.get("folder_id") || session.tree.root.id;

    // A folder was dropped: recreate its structure below the target folder.
    const folders = relativePath.split("/").filter(Boolean).slice(0, -1);
    for (const folderName of folders) {
      const parent = session.tree.getNode(folderId);
      const existing = parent?.children?.get(folderName);
      if (existing && existing.type === "folder") {
        folderId = existing.id;
      } else {
        folderId = (await session.tree.createFolder(folderId, folderName))._id;
      }
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await session.tree.writeUploadedFile(folderId, name, buffer);
    return json(result);
  },
);

route("GET", "/project/:projectId/entities", async ({ session }) => {
  const entities = [];
  for (const node of session.tree.walk()) {
    if (node.type === "folder") continue;
    entities.push({ path: "/" + session.tree.relPath(node), type: node.type });
  }
  return json({ project_id: session.id, entities });
});

// --------------------------------------------------------------- file content

function serveNode(session, node, request, { download = false } = {}) {
  return serveFile(session.tree.absPath(node), request, {
    downloadName: download ? node.name : undefined,
  });
}

route(
  "GET",
  "/project/:projectId/file/:entityId",
  async ({ session, params, request }) => {
    return serveNode(
      session,
      requireNode(session, params.entityId, ["file", "doc"]),
      request,
    );
  },
);

route(
  "GET",
  "/project/:projectId/doc/:entityId/download",
  async ({ session, params, request }) => {
    return serveNode(
      session,
      requireNode(session, params.entityId, ["doc"]),
      request,
      {
        download: true,
      },
    );
  },
);

route(
  "GET",
  "/project/:projectId/blob/:hash([0-9a-f]{40})",
  async ({ session, params, query, request }) => {
    let node = session.tree.getNodeByHash(params.hash);
    if (!node && query.get("fallback")) {
      node = session.tree.getNode(query.get("fallback"));
    }
    if (!node || node.type === "folder") return notFound();
    return serveNode(session, node, request);
  },
);

route(
  "HEAD",
  "/project/:projectId/blob/:hash([0-9a-f]{40})",
  async ({ session, params, request }) => {
    const node = session.tree.getNodeByHash(params.hash);
    if (!node) return notFound();
    return serveNode(session, node, request);
  },
);

route("GET", "/project/:projectId/download/zip", async ({ session }) => {
  // Zip the folder as it is on disk, minus VCS data and build by-products.
  const tmpDir = await fsp.mkdtemp(Path.join(os.tmpdir(), "localleaf-zip-"));
  const zipPath = Path.join(tmpDir, "project.zip");
  const files = [];
  for (const node of session.tree.walk()) {
    if (node.type !== "folder") files.push(session.tree.relPath(node));
  }
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(
        "zip",
        ["-q", "-@", zipPath],
        { cwd: session.rootPath, maxBuffer: 1024 * 1024 },
        (error) => (error ? reject(error) : resolve()),
      );
      child.stdin.end(files.join("\n") + "\n");
    });
    const buffer = await fsp.readFile(zipPath);
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(session.name)}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// -------------------------------------------------------------------- compile

route("POST", "/project/:projectId/compile", async ({ session, request }) => {
  const body = await readJson(request);
  const result = await session.compile({
    rootDocId: body.rootDoc_id,
    draft: Boolean(body.draft),
    stopOnFirstError: Boolean(body.stopOnFirstError),
  });
  return json(result);
});

route("POST", "/project/:projectId/compile/stop", async ({ session }) => {
  session.compiler.stop();
  return noContent();
});

route("DELETE", "/project/:projectId/output", async ({ session }) => {
  await session.clearCompileCache();
  return noContent();
});

function serveOutput({ session, params, request }, { download = false } = {}) {
  const name = decodeURIComponent(params.name);
  const absPath = session.compiler.outputFilePath(params.build, name);
  if (!absPath) return notFound();
  let downloadName;
  if (download || new URL(request.url).searchParams.has("popupDownload")) {
    // "output.pdf" -> "<main file>.pdf"
    const build =
      session.compiler.builds.get(params.build) ||
      session.compiler.latestBuild();
    const base = build?.base || session.name;
    downloadName = name.replace(/^output\./, `${base}.`);
  }
  const contentType =
    /\.(log|blg|aux|bbl|toc|out|fls|fdb_latexmk|stdout|stderr|bcf|lof|lot|nav|snm|idx|ilg|ind|glg|gls)$/.test(
      name,
    )
      ? "text/plain; charset=utf-8"
      : undefined;
  return serveFile(absPath, request, { downloadName, contentType });
}

route(
  "GET",
  `/project/:projectId/build/:build(${BUILD})/output/:name(.+)`,
  (ctx) => serveOutput(ctx),
);
route(
  "GET",
  `/project/:projectId/user/:userId/build/:build(${BUILD})/output/:name(.+)`,
  (ctx) => serveOutput(ctx),
);
route("GET", "/project/:projectId/output/:name(.+)", (ctx) => serveOutput(ctx));
route(
  "GET",
  `/download/project/:projectId/build/:build(${BUILD})/output/:name(.+)`,
  (ctx) => serveOutput(ctx, { download: true }),
);

// -------------------------------------------------------------------- synctex

function synctexContext(session, query) {
  const target = session.compiler.synctexTarget(query.get("buildId"));
  if (!target) throw new HttpError(404, "no compile to sync with");
  return {
    projectRoot: session.rootPath,
    target,
    texBinDir: session.appState.getCompileSettings().texBinDir,
  };
}

route("GET", "/project/:projectId/sync/code", async ({ session, query }) => {
  const file = query.get("file") || "";
  const line = parseInt(query.get("line"), 10);
  const column = parseInt(query.get("column"), 10);
  if (!file || isNaN(line) || isNaN(column) || file.split("/").includes("..")) {
    throw new HttpError(400, "invalid position");
  }
  const pdf = await Synctex.syncFromCode({
    ...synctexContext(session, query),
    file,
    line,
    column,
  });
  return json({ pdf, downloadedFromCache: false });
});

route("GET", "/project/:projectId/sync/pdf", async ({ session, query }) => {
  const page = parseInt(query.get("page"), 10);
  const h = parseFloat(query.get("h"));
  const v = parseFloat(query.get("v"));
  if (isNaN(page) || isNaN(h) || isNaN(v)) {
    throw new HttpError(400, "invalid position");
  }
  const code = await Synctex.syncFromPdf({
    ...synctexContext(session, query),
    page,
    h,
    v,
  });
  // Only positions inside the project folder can be opened.
  return json({
    code: code.filter(
      (position) => position.file && !position.file.startsWith(".."),
    ),
    downloadedFromCache: false,
  });
});

// ------------------------------------------------------------------- metadata

route("GET", "/project/:projectId/metadata", async ({ session }) => {
  return json({
    projectId: session.id,
    projectMeta: await session.metadataForProject(),
  });
});

// The editor indexes .bib files itself (from the project snapshot); this call
// only asks the server to tell other collaborators.
route("POST", "/project/:projectId/references/indexAll", async ({ session }) =>
  json({ projectId: session.id, keys: [] }),
);

route(
  "POST",
  "/project/:projectId/doc/:entityId/metadata",
  async ({ session, params }) => {
    const node = requireNode(session, params.entityId, ["doc"]);
    return json({ docId: node.id, meta: await session.metadataForDoc(node) });
  },
);

// ------------------------------------------------------------------- settings

route("POST", "/project/:projectId/settings", async ({ session, request }) => {
  session.updateSettings(await readJson(request));
  return noContent();
});

route("POST", "/user/settings", async ({ app, request }) => {
  app.appState.updateUserSettings(await readJson(request));
  return noContent();
});

route("POST", "/spelling/learn", async ({ app, request }) => {
  const { word } = await readJson(request);
  if (typeof word === "string" && word) app.appState.learnWord(word);
  return noContent();
});

route("POST", "/spelling/unlearn", async ({ app, request }) => {
  const { word } = await readJson(request);
  if (typeof word === "string" && word) app.appState.unlearnWord(word);
  return noContent();
});

route("POST", "/tutorial/:key/complete", async ({ app, params }) => {
  app.appState.completeTutorial(params.key);
  return noContent();
});

route("POST", "/tutorial/:key/postpone", async () => noContent());

// ------------------------------------------- project snapshot ("history" API)

route("POST", "/project/:projectId/flush", async () => noContent());

route("GET", "/project/:projectId/latest/history", async ({ session }) => {
  return json(session.snapshot.latestChunk());
});

route("GET", "/project/:projectId/changes", async ({ session, query }) => {
  const since = parseInt(query.get("since"), 10);
  return json(session.snapshot.changesSince(isNaN(since) ? -1 : since));
});

// ------------------------------------------------------- things we do not do

// Analytics, session tracking and error reporting go nowhere.
route("POST", "/event/:name", async () => noContent());
route("POST", "/editingSession/:projectId", async () => noContent());
route("PUT", "/editingSession/:projectId", async () => noContent());
route("POST", "/error/client", async () => noContent());
route("GET", "/system/messages", async () => json([]));
route("GET", "/project/:projectId/messages", async () => json([]));
route("GET", "/project/:projectId/threads", async () => json({}));
route("GET", "/project/:projectId/ranges", async () => json([]));
route("GET", "/project/:projectId/changes/users", async () => json([]));
route("GET", "/project/:projectId/tokens", async () => json({}));
route("GET", "/project/:projectId/members", async () => json({ members: [] }));
route("GET", "/project/:projectId/invites", async () => json({ invites: [] }));

/**
 * @return {Promise<Response | null>} null when no API route matches
 */
async function handleApiRequest({ request, url, app }) {
  const pathname = url.pathname;
  for (const { method, regex, names, handler } of routes) {
    if (method !== request.method) continue;
    const match = regex.exec(pathname);
    if (!match) continue;
    const params = {};
    names.forEach((name, index) => {
      params[name] = match[index + 1];
    });
    let session = null;
    if (params.projectId) {
      session = app.getSession(params.projectId);
      if (!session) return notFound("project is not open");
    }
    try {
      return await handler({
        session,
        params,
        query: url.searchParams,
        request,
        app,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return json(
          { message: error.message, ...(error.body || {}) },
          error.status,
        );
      }
      console.error(`${request.method} ${pathname} failed:`, error);
      return json({ message: error.message || "internal error" }, 500);
    }
  }
  return null;
}

module.exports = { handleApiRequest, FileTypes, text };
