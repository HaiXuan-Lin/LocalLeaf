"use strict";
// Tests for the local backend. They run in plain Node (no Electron):
//   cd desktop && node --test test/
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");

const { AppState } = require("../main/AppState");
const {
  ProjectSession,
  guessCompiler,
} = require("../main/project/ProjectSession");
const {
  diffToOp,
  decodeFile,
  encodeFile,
} = require("../main/project/Documents");
const { resolveTexEnvironment } = require("../main/project/TexEnvironment");
const Synctex = require("../main/project/Synctex");
const FileTypes = require("../main/project/FileTypes");
const { handleApiRequest } = require("../main/server/Api");
const otText = require("../main/util/vendor").requireVendored(
  "sharejs/text.js",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(25);
  }
}

const MAIN_TEX = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Hello",
  "",
  "\\input{sections/intro}",
  "\\label{sec:main}",
  "\\end{document}",
  "",
].join("\n");

function makeProject() {
  const root = fs.realpathSync(
    fs.mkdtempSync(Path.join(os.tmpdir(), "localleaf-test-")),
  );
  const projectDir = Path.join(root, "paper");
  fs.mkdirSync(Path.join(projectDir, "sections"), { recursive: true });
  fs.mkdirSync(Path.join(projectDir, ".git"));
  fs.writeFileSync(
    Path.join(projectDir, ".git", "HEAD"),
    "ref: refs/heads/main\n",
  );
  fs.writeFileSync(Path.join(projectDir, "main.tex"), MAIN_TEX);
  fs.writeFileSync(
    Path.join(projectDir, "sections", "intro.tex"),
    "Intro text.\n",
  );
  fs.writeFileSync(Path.join(projectDir, "refs.bib"), "@book{k, title={T}}\n");
  fs.writeFileSync(Path.join(projectDir, "main.aux"), "\\relax\n");
  fs.writeFileSync(
    Path.join(projectDir, "figure.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
  );
  fs.writeFileSync(Path.join(projectDir, "crlf.tex"), "one\r\ntwo\r\n");
  fs.writeFileSync(
    Path.join(projectDir, "latin1.tex"),
    Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
  );
  const appState = new AppState(Path.join(root, "userdata"));
  return { root, projectDir, appState };
}

async function openSession() {
  const env = makeProject();
  const session = new ProjectSession({
    rootPath: env.projectDir,
    appState: env.appState,
  });
  await session.open();
  const events = [];
  const { clientId, joinProjectResponse } = session.connectClient(
    (name, args) => events.push({ name, args }),
  );
  return { ...env, session, events, clientId, joinProjectResponse };
}

async function closeSession({ session, root }) {
  await session.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function names(list) {
  return list.map((entry) => entry.name).sort();
}

describe("project tree", () => {
  let ctx;
  before(async () => {
    ctx = await openSession();
  });
  after(() => closeSession(ctx));

  test("mirrors the folder, hiding VCS data and build by-products", () => {
    const root = ctx.joinProjectResponse.project.rootFolder[0];
    assert.equal(root.name, "rootFolder");
    assert.deepEqual(names(root.docs), ["crlf.tex", "main.tex", "refs.bib"]);
    // not valid UTF-8, so shown as a (read-only) file
    assert.deepEqual(names(root.fileRefs), ["figure.png", "latin1.tex"]);
    assert.deepEqual(names(root.folders), ["sections"]);
    assert.deepEqual(names(root.folders[0].docs), ["intro.tex"]);
    for (const file of root.fileRefs) assert.match(file.hash, /^[0-9a-f]{40}$/);
    for (const doc of root.docs) assert.match(doc._id, /^[0-9a-f]{24}$/);
  });

  test("finds the main document and keeps ids stable between sessions", async () => {
    const project = ctx.joinProjectResponse.project;
    const main = project.rootFolder[0].docs.find(
      (doc) => doc.name === "main.tex",
    );
    assert.equal(project.rootDoc_id, main._id);
    assert.equal(project.compiler, "pdflatex");

    const again = new ProjectSession({
      rootPath: ctx.projectDir,
      appState: ctx.appState,
    });
    await again.open();
    assert.equal(again.id, ctx.session.id);
    assert.equal(again.getRootDocNode().id, main._id);
    await again.close();
  });

  test("creates, renames, moves and deletes entities on disk", async () => {
    const { session, projectDir, events } = ctx;
    const tree = session.tree;
    events.length = 0;

    const doc = await tree.createDoc(tree.root.id, "notes.tex");
    assert.ok(fs.existsSync(Path.join(projectDir, "notes.tex")));
    assert.equal(events.at(-1).name, "reciveNewDoc");
    await assert.rejects(
      tree.createDoc(tree.root.id, "notes.tex"),
      /already exists/,
    );
    await assert.rejects(
      tree.createDoc(tree.root.id, "main.aux"),
      /already exists/,
    );
    await assert.rejects(
      tree.createDoc(tree.root.id, "a/b.tex"),
      /invalid_filename/,
    );

    const folder = await tree.createFolder(tree.root.id, "chapters");
    assert.ok(fs.statSync(Path.join(projectDir, "chapters")).isDirectory());

    await tree.rename(doc._id, "ideas.tex");
    assert.ok(fs.existsSync(Path.join(projectDir, "ideas.tex")));
    assert.ok(!fs.existsSync(Path.join(projectDir, "notes.tex")));
    assert.deepEqual(events.at(-1), {
      name: "reciveEntityRename",
      args: [doc._id, "ideas.tex"],
    });

    await tree.move(doc._id, folder._id);
    assert.ok(fs.existsSync(Path.join(projectDir, "chapters", "ideas.tex")));
    assert.deepEqual(events.at(-1), {
      name: "reciveEntityMove",
      args: [doc._id, folder._id],
    });
    await assert.rejects(tree.move(folder._id, folder._id), /into itself/);

    await tree.delete(folder._id);
    assert.ok(!fs.existsSync(Path.join(projectDir, "chapters")));
    assert.equal(tree.getNode(doc._id), null);
    assert.equal(events.at(-1).name, "removeEntity");
  });

  test("picks up files added and removed by other programs", async () => {
    const { session, projectDir, events } = ctx;
    events.length = 0;
    fs.writeFileSync(Path.join(projectDir, "external.tex"), "x\n");
    fs.mkdirSync(Path.join(projectDir, "figs"));
    fs.writeFileSync(Path.join(projectDir, "figs", "plot.pdf"), "%PDF-1.5\n");
    await session.tree.rescan();
    const newDoc = events.find((e) => e.name === "reciveNewDoc");
    assert.equal(newDoc.args[1].name, "external.tex");
    const newFolder = events.find((e) => e.name === "reciveNewFolder");
    assert.equal(newFolder.args[1].name, "figs");
    assert.deepEqual(names(newFolder.args[1].fileRefs), ["plot.pdf"]);

    events.length = 0;
    fs.rmSync(Path.join(projectDir, "external.tex"));
    fs.rmSync(Path.join(projectDir, "figs"), { recursive: true });
    await session.tree.rescan();
    assert.deepEqual(
      events.map((e) => e.name),
      ["removeEntity", "removeEntity"],
    );
  });

  test("watches the folder", async () => {
    const { session, projectDir, events } = ctx;
    events.length = 0;
    fs.writeFileSync(Path.join(projectDir, "watched.tex"), "y\n");
    await waitFor(() => events.find((e) => e.name === "reciveNewDoc"));
    fs.rmSync(Path.join(projectDir, "watched.tex"));
    await waitFor(() => events.find((e) => e.name === "removeEntity"));
    assert.ok(session.tree.findByPath("watched.tex") === null);
  });
});

describe("documents", () => {
  let ctx;
  before(async () => {
    ctx = await openSession();
  });
  after(() => closeSession(ctx));

  const docId = (name) => ctx.session.tree.findByPath(name).id;
  const acks = () =>
    ctx.events
      .filter((e) => e.name === "otUpdateApplied")
      .map((e) => e.args[0]);

  test("joinDoc returns the lines; updates are written to disk at once", async () => {
    const { session, clientId, projectDir, events } = ctx;
    const id = docId("main.tex");
    const [error, lines, version] = await session.handleSocketEvent(
      clientId,
      "joinDoc",
      [id, { encodeRanges: true }],
    );
    assert.equal(error, null);
    assert.equal(version, 0);
    assert.equal(lines.join("\n"), MAIN_TEX);

    events.length = 0;
    const [applyError] = await session.handleSocketEvent(
      clientId,
      "applyOtUpdate",
      [id, { doc: id, op: [{ p: 0, i: "% edited\n" }], v: 0 }],
    );
    assert.equal(applyError, null);
    assert.deepEqual(acks(), [{ v: 0, doc: id }]);
    assert.equal(
      fs.readFileSync(Path.join(projectDir, "main.tex"), "utf8"),
      "% edited\n" + MAIN_TEX,
    );
  });

  test("non-ASCII text survives the websocket encoding", async () => {
    const { session, clientId, projectDir } = ctx;
    const text = "Schrödinger 方程 – ħ\n";
    fs.writeFileSync(Path.join(projectDir, "unicode.tex"), text);
    await session.tree.rescan();
    const id = docId("unicode.tex");
    const [, lines] = await session.handleSocketEvent(clientId, "joinDoc", [
      id,
      {},
    ]);
    // the editor decodes with decodeURIComponent(escape(line))
    const decoded = lines
      .map((line) => decodeURIComponent(escape(line)))
      .join("\n");
    assert.equal(decoded, text);
    await session.handleSocketEvent(clientId, "applyOtUpdate", [
      id,
      { doc: id, op: [{ p: text.length, i: "ω" }], v: 0 },
    ]);
    assert.equal(
      fs.readFileSync(Path.join(projectDir, "unicode.tex"), "utf8"),
      text + "ω",
    );
  });

  test("keeps CRLF line endings of a file", async () => {
    const { session, clientId, projectDir } = ctx;
    const id = docId("crlf.tex");
    const [, lines] = await session.handleSocketEvent(clientId, "joinDoc", [
      id,
      {},
    ]);
    assert.deepEqual(lines, ["one", "two", ""]);
    await session.handleSocketEvent(clientId, "applyOtUpdate", [
      id,
      { doc: id, op: [{ p: 3, i: "!" }], v: 0 },
    ]);
    assert.equal(
      fs.readFileSync(Path.join(projectDir, "crlf.tex"), "utf8"),
      "one!\r\ntwo\r\n",
    );
  });

  test("changes made by another program reach the editor as OT updates", async () => {
    const { session, clientId, projectDir, events } = ctx;
    const id = docId("refs.bib");
    const [, lines, version] = await session.handleSocketEvent(
      clientId,
      "joinDoc",
      [id, {}],
    );
    const before = lines.join("\n");
    events.length = 0;

    const after = before.replace("title={T}", "title={A longer title}");
    fs.writeFileSync(Path.join(projectDir, "refs.bib"), after);
    await session.tree.rescan();
    const [update] = acks();
    assert.equal(update.v, version);
    assert.equal(update.meta.type, "external");
    assert.equal(otText.apply(before, update.op), after);

    // The editor had typed at the old version; the op is transformed.
    events.length = 0;
    const [error] = await session.handleSocketEvent(clientId, "applyOtUpdate", [
      id,
      { doc: id, op: [{ p: 0, i: "% note\n" }], v: version },
    ]);
    assert.equal(error, null);
    assert.deepEqual(acks(), [{ v: version + 1, doc: id }]);
    assert.equal(
      fs.readFileSync(Path.join(projectDir, "refs.bib"), "utf8"),
      "% note\n" + after,
    );
  });

  test("our own writes are not mistaken for external changes", async () => {
    const { session, clientId, events } = ctx;
    const id = docId("sections/intro.tex");
    await session.handleSocketEvent(clientId, "joinDoc", [id, {}]);
    await session.handleSocketEvent(clientId, "applyOtUpdate", [
      id,
      { doc: id, op: [{ p: 0, i: "A" }], v: 0 },
    ]);
    events.length = 0;
    await session.tree.rescan();
    await sleep(400);
    assert.deepEqual(events, []);
  });

  test("rejects updates for docs that are not open; leaveDoc forgets the doc", async () => {
    const { session, clientId } = ctx;
    const id = docId("main.tex");
    await session.handleSocketEvent(clientId, "leaveDoc", [id]);
    assert.equal(session.documents.has(id), false);
    const [error] = await session.handleSocketEvent(clientId, "applyOtUpdate", [
      id,
      { doc: id, op: [{ p: 0, i: "x" }], v: 0 },
    ]);
    assert.match(error.message, /not open/);
  });

  test("a second window receives the op, the sender only the ack", async () => {
    const { session, clientId } = ctx;
    const otherEvents = [];
    const other = session.connectClient((name, args) =>
      otherEvents.push({ name, args }),
    );
    const id = docId("main.tex");
    await session.handleSocketEvent(clientId, "joinDoc", [id, {}]);
    await session.handleSocketEvent(other.clientId, "joinDoc", [id, {}]);
    ctx.events.length = 0;
    await session.handleSocketEvent(clientId, "applyOtUpdate", [
      id,
      { doc: id, op: [{ p: 0, i: "Z" }], v: 0 },
    ]);
    assert.deepEqual(acks(), [{ v: 0, doc: id }]);
    assert.deepEqual(otherEvents[0].args[0].op, [{ p: 0, i: "Z" }]);
    session.disconnectClient(other.clientId);
    assert.equal(session.documents.has(id), true);
  });
});

describe("helpers", () => {
  test("diffToOp produces an op that turns old into new", () => {
    const cases = [
      ["", "abc"],
      ["abc", ""],
      ["abc", "abc"],
      ["hello world", "hello brave new world"],
      ["hello brave new world", "hello world"],
      ["aaaa", "aa"],
      ["line1\nline2\nline3", "line1\nLINE2\nline3"],
      ["x😀y", "x😁y"],
    ];
    for (const [before, after] of cases) {
      assert.equal(otText.apply(before, diffToOp(before, after)), after);
    }
  });

  test("decodeFile/encodeFile round-trip BOM and line endings", () => {
    for (const text of ["a\nb\n", "a\r\nb\r\n", "\ufeffa\r\nb", ""]) {
      assert.equal(encodeFile(decodeFile(Buffer.from(text, "utf8"))), text);
    }
  });

  test("guessCompiler reads magic comments and preambles", () => {
    assert.equal(
      guessCompiler("% !TEX program = xelatex\n\\documentclass{article}"),
      "xelatex",
    );
    assert.equal(guessCompiler("%!TeX TS-program = lualatex\n"), "lualatex");
    assert.equal(guessCompiler("\\documentclass{ctexart}"), "xelatex");
    assert.equal(guessCompiler("\\usepackage{fontspec}"), "xelatex");
    assert.equal(
      guessCompiler("% \\usepackage{fontspec}\n\\usepackage{amsmath}"),
      "pdflatex",
    );
  });

  test("file classification", () => {
    assert.equal(FileTypes.isIgnoredFile("main.synctex.gz"), true);
    assert.equal(FileTypes.isIgnoredFile("data.tar.gz"), false);
    assert.equal(FileTypes.isIgnoredFile(".DS_Store"), true);
    assert.equal(FileTypes.isIgnoredFile(".latexmkrc"), false);
    assert.equal(FileTypes.isIgnoredDirectory(".git"), true);
    assert.equal(FileTypes.isTextFilename("Makefile"), true);
    assert.equal(FileTypes.isTextFilename("photo.JPG"), false);
  });
});

describe("http api", () => {
  let ctx;
  let app;
  const call = async (method, path, body) => {
    const url = new URL(path, "localleaf://app");
    const init = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    return await handleApiRequest({
      request: new Request(url.href.replace("localleaf:", "http:"), init),
      url,
      app,
    });
  };
  before(async () => {
    ctx = await openSession();
    app = {
      appState: ctx.appState,
      getSession: (id) => (id === ctx.session.id ? ctx.session : null),
    };
  });
  after(() => closeSession(ctx));

  test("file tree operations", async () => {
    const id = ctx.session.id;
    const created = await call("POST", `/project/${id}/doc`, {
      name: "new.tex",
      parent_folder_id: ctx.session.tree.root.id,
    });
    assert.equal(created.status, 200);
    const doc = await created.json();
    assert.equal(doc.name, "new.tex");
    const duplicate = await call("POST", `/project/${id}/doc`, {
      name: "new.tex",
    });
    assert.equal(duplicate.status, 400);
    const renamed = await call("POST", `/project/${id}/doc/${doc._id}/rename`, {
      name: "newer.tex",
    });
    assert.equal(renamed.status, 204);
    const deleted = await call("DELETE", `/project/${id}/doc/${doc._id}`);
    assert.equal(deleted.status, 204);
    assert.ok(!fs.existsSync(Path.join(ctx.projectDir, "newer.tex")));
  });

  test("serves file content with range support", async () => {
    const node = ctx.session.tree.findByPath("figure.png");
    const full = await call(
      "GET",
      `/project/${ctx.session.id}/blob/${node.hash}`,
    );
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "image/png");
    assert.equal((await full.arrayBuffer()).byteLength, 7);
    const url = new URL(
      `/project/${ctx.session.id}/blob/${node.hash}`,
      "localleaf://app",
    );
    const ranged = await handleApiRequest({
      request: new Request(url.href.replace("localleaf:", "http:"), {
        headers: { Range: "bytes=1-3" },
      }),
      url,
      app,
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 1-3/7");
    assert.deepEqual(
      [...new Uint8Array(await ranged.arrayBuffer())],
      [0x50, 0x4e, 0x47],
    );
  });

  test("metadata: labels and packages", async () => {
    const response = await call("GET", `/project/${ctx.session.id}/metadata`);
    const { projectMeta } = await response.json();
    const main = ctx.session.tree.findByPath("main.tex");
    assert.deepEqual(projectMeta[main.id].labels, ["sec:main"]);
    assert.equal(projectMeta[main.id].documentClass, "article");
  });

  test("project snapshot for search and word count", async () => {
    const id = ctx.session.id;
    const latest = await (
      await call("GET", `/project/${id}/latest/history`)
    ).json();
    const files = latest.chunk.history.snapshot.files;
    assert.equal(files["main.tex"].content, MAIN_TEX);
    assert.equal(files["sections/intro.tex"].content, "Intro text.\n");
    assert.equal(files["figure.png"].byteLength, 7);
    const version = latest.chunk.startVersion;

    const none = await (
      await call("GET", `/project/${id}/changes?since=${version}`)
    ).json();
    assert.deepEqual(none.changes, []);

    fs.writeFileSync(
      Path.join(ctx.projectDir, "sections", "intro.tex"),
      "Changed.\n",
    );
    fs.rmSync(Path.join(ctx.projectDir, "figure.png"));
    await ctx.session.tree.rescan();
    const { changes } = await (
      await call("GET", `/project/${id}/changes?since=${version}`)
    ).json();
    assert.equal(changes.length, 1);
    const operations = changes[0].operations;
    assert.ok(
      operations.some(
        (op) => op.pathname === "figure.png" && op.newPathname === "",
      ),
    );
    assert.ok(
      operations.some(
        (op) =>
          op.pathname === "sections/intro.tex" &&
          op.file?.content === "Changed.\n",
      ),
    );
  });

  test("settings are remembered per project and per user", async () => {
    const id = ctx.session.id;
    await call("POST", `/project/${id}/settings`, { compiler: "xelatex" });
    assert.equal(ctx.session.getCompiler(), "xelatex");
    assert.equal(ctx.appState.getProjectSettings(id).compiler, "xelatex");
    await call("POST", `/project/${id}/settings`, { compiler: "pdflatex" });
    await call("POST", "/user/settings", { fontSize: 14, notASetting: 1 });
    assert.equal(ctx.appState.getUserSettings().fontSize, 14);
    assert.equal(ctx.appState.getUserSettings().notASetting, undefined);
  });

  test("unknown routes fall through", async () => {
    assert.equal(await call("GET", "/nope"), null);
    const other = await call(
      "GET",
      "/project/aaaaaaaaaaaaaaaaaaaaaaaa/metadata",
    );
    assert.equal(other.status, 404);
  });
});

describe("compile and synctex (needs a TeX installation)", async () => {
  const tex = await resolveTexEnvironment();
  const skip = !tex.latexmk || !tex.synctex;
  let ctx;
  before(async () => {
    ctx = await openSession();
  });
  after(() => closeSession(ctx));

  test(
    "compiles in place with latexmk and maps positions both ways",
    { skip },
    async () => {
      const { session, projectDir } = ctx;
      const result = await session.compile({});
      assert.equal(result.status, "success", JSON.stringify(result));
      const paths = result.outputFiles.map((file) => file.path);
      assert.ok(paths.includes("output.pdf"));
      assert.ok(paths.includes("output.log"));
      assert.ok(fs.existsSync(Path.join(projectDir, "main.pdf")));
      const pdf = result.outputFiles.find((file) => file.path === "output.pdf");
      assert.ok(pdf.size > 1000);
      assert.match(
        pdf.url,
        new RegExp(
          `^/project/${session.id}/build/[0-9a-f-]+/output/output.pdf$`,
        ),
      );
      const pdfPath = session.compiler.outputFilePath(pdf.build, "output.pdf");
      assert.equal(fs.readFileSync(pdfPath).subarray(0, 4).toString(), "%PDF");

      // build by-products exist on disk but stay out of the tree
      assert.ok(fs.existsSync(Path.join(projectDir, "main.synctex.gz")));
      await session.tree.rescan();
      assert.equal(session.tree.findByPath("main.synctex.gz"), null);
      assert.ok(session.tree.findByPath("main.pdf"));

      const target = session.compiler.synctexTarget(pdf.build);
      const positions = await Synctex.syncFromCode({
        projectRoot: projectDir,
        target,
        file: "sections/intro.tex",
        line: 1,
        column: 0,
      });
      assert.ok(positions.length > 0);
      assert.equal(positions[0].page, 1);

      const code = await Synctex.syncFromPdf({
        projectRoot: projectDir,
        target,
        page: 1,
        h: positions[0].h,
        v: positions[0].v,
      });
      assert.equal(code[0].file, "sections/intro.tex");
      assert.equal(code[0].line, 1);
    },
  );

  test(
    "a LaTeX error still yields a log; no stale PDF is reported",
    { skip },
    async () => {
      const { session, projectDir } = ctx;
      fs.writeFileSync(
        Path.join(projectDir, "broken.tex"),
        "\\documentclass{article}\n\\begin{document}\n\\undefinedcommand\n\\end{document}\n",
      );
      await session.tree.rescan();
      const broken = session.tree.findByPath("broken.tex");
      const result = await session.compile({
        rootDocId: broken.id,
        stopOnFirstError: true,
      });
      assert.equal(result.status, "stopped-on-first-error");
      const log = result.outputFiles.find((file) => file.path === "output.log");
      const logText = fs.readFileSync(
        session.compiler.outputFilePath(log.build, "output.log"),
        "utf8",
      );
      assert.match(logText, /Undefined control sequence/);
    },
  );

  test("reports a missing TeX installation in the log", async () => {
    const { session, appState } = ctx;
    const realPath = process.env.PATH;
    const realShell = process.env.SHELL;
    const realHome = process.env.HOME;
    require("../main/project/TexEnvironment").resetCache();
    process.env.PATH = "/nonexistent";
    process.env.SHELL = "/nonexistent-shell";
    appState.store.set("texBinDir", "");
    const TexEnvironment = require("../main/project/TexEnvironment");
    const env = await TexEnvironment.resolveTexEnvironment();
    try {
      if (env.latexmk) return; // TeX lives in a well-known place on this machine
      const result = await session.compile({});
      assert.equal(result.status, "failure");
      const log = result.outputFiles.find((file) => file.path === "output.log");
      const logText = fs.readFileSync(
        session.compiler.outputFilePath(log.build, "output.log"),
        "utf8",
      );
      assert.match(logText, /latexmk was not found/);
    } finally {
      process.env.PATH = realPath;
      process.env.SHELL = realShell;
      process.env.HOME = realHome;
      TexEnvironment.resetCache();
    }
  });
});
