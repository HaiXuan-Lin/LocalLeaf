"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { resolveTexEnvironment } = require("./TexEnvironment");
const FileTypes = require("./FileTypes");

// Same mapping as Overleaf's CLSI service (services/clsi/app/js/LatexRunner.js)
const COMPILER_FLAGS = {
  latex: "-pdfdvi",
  lualatex: "-lualatex",
  pdflatex: "-pdf",
  xelatex: "-xelatex",
};

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_CAPTURED_OUTPUT = 2 * 1024 * 1024;
const KEPT_BUILDS = 3;

// Files next to the PDF that are offered under "Other logs and files".
const OUTPUT_EXTENSIONS = [
  "pdf",
  "log",
  "aux",
  "bbl",
  "bcf",
  "blg",
  "fdb_latexmk",
  "fls",
  "glg",
  "gls",
  "idx",
  "ilg",
  "ind",
  "lof",
  "lot",
  "nav",
  "out",
  "run.xml",
  "snm",
  "synctex.gz",
  "toc",
  "xdv",
  "dvi",
];

function newBuildId() {
  return `${Date.now().toString(16)}-${crypto.randomBytes(8).toString("hex")}`;
}

function fileType(path) {
  if (path.endsWith(".synctex.gz")) return "gz";
  return Path.extname(path).slice(1);
}

/** Strip the extension that latexmk strips to get the job name. */
function jobName(filename) {
  return filename.replace(/\.[^./\\]+$/, "");
}

function killProcessGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The child is a process group leader (detached), so this also reaches
    // pdflatex/bibtex/... started by latexmk.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/**
 * Runs latexmk from the user's TeX installation inside the project folder and
 * reports the result in the format of Overleaf's compile API.
 */
class Compiler {
  /**
   * @param {object} options
   * @param {import('./ProjectTree').ProjectTree} options.tree
   * @param {string} options.buildsDir where per-build copies of the PDF and
   *        log are kept, so the viewer never reads a half-written file
   * @param {() => {compiler: string, texBinDir?: string, compileTimeout?: number}} options.getSettings
   */
  constructor({ tree, buildsDir, getSettings }) {
    this.tree = tree;
    this.buildsDir = buildsDir;
    this.getSettings = getSettings;
    this.running = null;
    this.builds = new Map();
    this.lastCompileWasDraft = false;
  }

  get projectId() {
    return this.tree.id;
  }

  isRunning() {
    return this.running !== null;
  }

  /**
   * @param {object} options
   * @param {object|null} options.rootNode the doc to compile
   * @param {boolean} [options.draft]
   * @param {boolean} [options.stopOnFirstError]
   */
  async compile({ rootNode, draft = false, stopOnFirstError = false }) {
    if (this.running) {
      return this._response("compile-in-progress", null, []);
    }
    const startedAt = Date.now();
    const buildId = newBuildId();
    const buildDir = Path.join(this.buildsDir, buildId);
    await fsp.mkdir(buildDir, { recursive: true });
    const build = {
      id: buildId,
      dir: buildDir,
      files: new Map(),
      rootDir: null,
      base: null,
    };
    this.builds.set(buildId, build);

    const settings = this.getSettings();
    const fail = async (status, message) => {
      await this._writeSyntheticLog(build, message);
      return this._response(status, build, this._outputFiles(build), startedAt);
    };

    if (!rootNode || rootNode.type !== "doc" || rootNode.removed) {
      return await fail(
        "failure",
        [
          "! No main document.",
          "",
          "There is no .tex file with \\documentclass to compile in this folder.",
          "Open the file you want to compile, or choose the main document in",
          "Settings > Compiler.",
        ].join("\n"),
      );
    }

    const compilerFlag =
      COMPILER_FLAGS[settings.compiler] || COMPILER_FLAGS.pdflatex;
    const tex = await resolveTexEnvironment({
      customBinDir: settings.texBinDir,
    });
    if (!tex.latexmk) {
      return await fail(
        "failure",
        [
          "! latexmk was not found.",
          "",
          "This app does not include TeX: it compiles with the TeX distribution",
          "installed on your computer (MacTeX / TeX Live), and could not find",
          "one. Install MacTeX (https://tug.org/mactex/) or TeX Live. If it is",
          "installed in an unusual place, choose the folder that contains latexmk",
          "in Settings > Editor > TeX distribution.",
          "",
          "Searched in:",
          ...tex.dirs.map((dir) => `  ${dir}`),
        ].join("\n"),
      );
    }

    const rootAbsPath = this.tree.absPath(rootNode);
    const rootDir = Path.dirname(rootAbsPath);
    const rootFile = Path.basename(rootAbsPath);
    const base = jobName(rootFile);
    build.rootDir = rootDir;
    build.base = base;

    const args = ["-cd", "-synctex=1", "-interaction=batchmode"];
    if (stopOnFirstError) {
      args.push("-halt-on-error");
    } else {
      // Run all passes despite errors, as Overleaf does.
      args.push("-f");
    }
    if (draft) {
      args.push(
        "-usepretex=\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{draft}{graphics}",
      );
    }
    if (draft || this.lastCompileWasDraft) {
      // latexmk does not notice that the pre-code changed: force a run.
      args.push("-g");
    }
    args.push(compilerFlag, rootFile);

    const timeoutSeconds =
      Number(settings.compileTimeout) > 0
        ? Number(settings.compileTimeout)
        : DEFAULT_TIMEOUT_SECONDS;

    const result = await this._run(tex, args, rootDir, timeoutSeconds * 1000);
    this.lastCompileWasDraft = draft;

    await fsp.writeFile(Path.join(buildDir, "output.stdout"), result.stdout);
    await fsp.writeFile(Path.join(buildDir, "output.stderr"), result.stderr);
    build.files.set("output.stdout", Path.join(buildDir, "output.stdout"));
    build.files.set("output.stderr", Path.join(buildDir, "output.stderr"));

    // Find what the run left next to the main file.
    const pdfPath = Path.join(rootDir, `${base}.pdf`);
    const logPath = Path.join(rootDir, `${base}.log`);
    let pdfIsCurrent = false;
    try {
      const pdfStat = await fsp.stat(pdfPath);
      // A PDF from an earlier run only counts when latexmk says that
      // everything is up to date (exit code 0).
      pdfIsCurrent =
        pdfStat.size > 0 &&
        (result.code === 0 || pdfStat.mtimeMs >= startedAt - 2000);
    } catch {}

    for (const extension of OUTPUT_EXTENSIONS) {
      const source = Path.join(rootDir, `${base}.${extension}`);
      if (extension === "pdf" && !pdfIsCurrent) continue;
      if (!fs.existsSync(source)) continue;
      const name = `output.${extension}`;
      if (extension === "pdf" || extension === "log") {
        // Snapshot these two: the next compile rewrites them in place.
        const copy = Path.join(buildDir, name);
        try {
          await fsp.copyFile(source, copy, fs.constants.COPYFILE_FICLONE);
          build.files.set(name, copy);
        } catch {
          build.files.set(name, source);
        }
      } else {
        build.files.set(name, source);
      }
    }

    let status;
    if (result.timedOut) {
      status = "timedout";
    } else if (result.terminated) {
      status = "terminated";
    } else if (result.spawnError) {
      status = "failure";
    } else if (pdfIsCurrent) {
      status =
        stopOnFirstError && result.code !== 0
          ? "stopped-on-first-error"
          : "success";
    } else {
      status = stopOnFirstError ? "stopped-on-first-error" : "failure";
    }

    if (!build.files.has("output.log")) {
      // TeX never got as far as writing a log: show what latexmk said.
      const lines = [];
      if (result.spawnError) {
        lines.push(`! Could not start latexmk: ${result.spawnError.message}`);
      } else if (result.timedOut) {
        lines.push(`! Compile timed out after ${timeoutSeconds} seconds.`);
      } else {
        lines.push(
          `! latexmk exited with code ${result.code} before TeX wrote a log.`,
        );
      }
      lines.push(
        "",
        `Command: ${tex.latexmk} ${args.join(" ")}`,
        `Folder: ${rootDir}`,
        "",
      );
      if (result.stderr.trim()) lines.push(result.stderr.trim(), "");
      if (result.stdout.trim()) lines.push(result.stdout.trim(), "");
      await this._writeSyntheticLog(build, lines.join("\n"));
    }

    this._pruneBuilds();
    // The compile may have created files that belong in the tree.
    this.tree.scheduleRescan();
    return this._response(status, build, this._outputFiles(build), startedAt);
  }

  /** Stop the running compile, if any. */
  stop() {
    if (!this.running) return;
    this.running.terminated = true;
    killProcessGroup(this.running.child, "SIGTERM");
    const child = this.running.child;
    setTimeout(() => killProcessGroup(child, "SIGKILL"), 2000).unref?.();
  }

  /**
   * "Clear cached files": remove the by-products of the last compiles
   * (latexmk -c), keeping the PDFs.
   */
  async clearCache(rootNodes) {
    this.stop();
    const tex = await resolveTexEnvironment({
      customBinDir: this.getSettings().texBinDir,
    });
    const targets = new Map();
    for (const build of this.builds.values()) {
      if (build.rootDir && build.base) {
        targets.set(Path.join(build.rootDir, build.base), build);
      }
    }
    for (const node of rootNodes || []) {
      if (!node || node.removed) continue;
      const absPath = this.tree.absPath(node);
      targets.set(
        Path.join(Path.dirname(absPath), jobName(Path.basename(absPath))),
        {
          rootDir: Path.dirname(absPath),
          base: jobName(Path.basename(absPath)),
        },
      );
    }
    for (const { rootDir, base } of targets.values()) {
      if (tex.latexmk) {
        await this._run(tex, ["-c", base], rootDir, 30000);
      }
      // latexmk -c leaves a few by-products behind (and may be unavailable).
      for (const name of await fsp.readdir(rootDir).catch(() => [])) {
        if (name.startsWith(`${base}.`) && FileTypes.isBuildArtifact(name)) {
          await fsp.rm(Path.join(rootDir, name), { force: true });
        }
      }
    }
    await fsp.rm(this.buildsDir, { recursive: true, force: true });
    this.builds.clear();
  }

  /** Absolute path of an output file of a build, or null. */
  outputFilePath(buildId, name) {
    const build = buildId ? this.builds.get(buildId) : this.latestBuild();
    return build?.files.get(name) || null;
  }

  latestBuild() {
    let latest = null;
    for (const build of this.builds.values()) latest = build;
    return latest;
  }

  /** Where SyncTeX should look for a build: {pdfPath, rootDir}. */
  synctexTarget(buildId) {
    const build = (buildId && this.builds.get(buildId)) || this.latestBuild();
    if (!build || !build.rootDir) return null;
    return {
      rootDir: build.rootDir,
      pdfPath: Path.join(build.rootDir, `${build.base}.pdf`),
    };
  }

  async dispose() {
    this.stop();
    await fsp
      .rm(this.buildsDir, { recursive: true, force: true })
      .catch(() => {});
  }

  // -------------------------------------------------------------- internals

  _run(tex, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
      const result = {
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        terminated: false,
        spawnError: null,
      };
      let child;
      try {
        child = spawn(tex.latexmk, args, {
          cwd,
          env: { ...process.env, PATH: tex.PATH },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        result.spawnError = error;
        return resolve(result);
      }
      const running = { child, terminated: false };
      this.running = running;
      const capture = (key) => (chunk) => {
        if (result[key].length < MAX_CAPTURED_OUTPUT) {
          result[key] += chunk.toString("utf8");
        }
      };
      child.stdout.on("data", capture("stdout"));
      child.stderr.on("data", capture("stderr"));
      const timer = setTimeout(() => {
        result.timedOut = true;
        killProcessGroup(child, "SIGTERM");
        setTimeout(() => killProcessGroup(child, "SIGKILL"), 2000).unref?.();
      }, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        if (this.running === running) this.running = null;
        result.terminated = running.terminated;
        resolve(result);
      };
      child.on("error", (error) => {
        result.spawnError = error;
        finish();
      });
      child.on("close", (code) => {
        result.code = code;
        finish();
      });
    });
  }

  /**
   * A log for compiles in which TeX never ran. It is written the way TeX
   * writes errors ("! message"), so the editor's log parser lists it as an
   * error; that parser skips the first line (TeX's banner).
   */
  async _writeSyntheticLog(build, text) {
    const path = Path.join(build.dir, "output.log");
    await fsp.mkdir(build.dir, { recursive: true });
    const banner = "This log was written by the app: TeX did not run.\n\n";
    await fsp.writeFile(path, banner + text + "\n");
    build.files.set("output.log", path);
  }

  _outputFiles(build) {
    const files = [];
    for (const [name, absPath] of build.files) {
      const entry = {
        path: name,
        url: `/project/${this.projectId}/build/${build.id}/output/${name}`,
        type: fileType(name),
        build: build.id,
      };
      if (name === "output.pdf") {
        try {
          entry.size = fs.statSync(absPath).size;
        } catch {
          entry.size = 0;
        }
        entry.ranges = [];
        entry.createdAt = new Date().toISOString();
      }
      files.push(entry);
    }
    return files;
  }

  _response(status, build, outputFiles, startedAt = Date.now()) {
    return {
      status,
      outputFiles,
      compileGroup: "standard",
      pdfDownloadDomain: "",
      pdfCachingMinChunkSize: 0,
      stats: {},
      timings: { compileE2E: Date.now() - startedAt },
      buildId: build?.id,
    };
  }

  _pruneBuilds() {
    const ids = [...this.builds.keys()];
    for (const id of ids.slice(0, Math.max(0, ids.length - KEPT_BUILDS))) {
      const build = this.builds.get(id);
      this.builds.delete(id);
      fsp.rm(build.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { Compiler, COMPILER_FLAGS, jobName };
