"use strict";
const Path = require("node:path");
const { execFile } = require("node:child_process");
const { resolveTexEnvironment } = require("./TexEnvironment");

/**
 * SyncTeX lookups using the `synctex` command line tool that ships with TeX
 * Live. The output parsing is ported from Overleaf's CLSI service
 * (services/clsi/app/js/SynctexOutputParser.js).
 */

function splitLine(line) {
  const splitIndex = line.indexOf(":");
  if (splitIndex === -1) return ["", line];
  return [line.slice(0, splitIndex).trim(), line.slice(splitIndex + 1).trim()];
}

function parseOutput(output, processLine) {
  const records = [];
  let currentRecord = null;
  for (const line of output.split("\n")) {
    const [label, value] = splitLine(line);
    if (label === "Output") {
      currentRecord = {};
      records.push(currentRecord);
      continue;
    }
    if (currentRecord == null) continue;
    processLine(currentRecord, label, value);
  }
  return records;
}

function setInt(record, prop, value) {
  const parsed = parseInt(value, 10);
  if (!isNaN(parsed)) record[prop] = parsed;
}

function setFloat(record, prop, value) {
  const parsed = parseFloat(value);
  if (!isNaN(parsed)) record[prop] = parsed;
}

function parseViewOutput(output) {
  return parseOutput(output, (record, label, value) => {
    switch (label) {
      case "Page":
        setInt(record, "page", value);
        break;
      case "h":
        setFloat(record, "h", value);
        break;
      case "v":
        setFloat(record, "v", value);
        break;
      case "W":
        setFloat(record, "width", value);
        break;
      case "H":
        setFloat(record, "height", value);
        break;
    }
  });
}

function parseEditOutput(output, projectRoot, rootDir) {
  return parseOutput(output, (record, label, value) => {
    switch (label) {
      case "Input": {
        // Paths are recorded as TeX saw them: absolute, or relative to the
        // folder of the main file, possibly with "./" segments.
        const absolute = Path.isAbsolute(value)
          ? Path.normalize(value)
          : Path.resolve(rootDir, value);
        record.file = Path.relative(projectRoot, absolute)
          .split(Path.sep)
          .join("/");
        break;
      }
      case "Line":
        setInt(record, "line", value);
        break;
      case "Column":
        setInt(record, "column", value);
        break;
    }
  });
}

function run(synctex, args, cwd, env) {
  return new Promise((resolve, reject) => {
    execFile(
      synctex,
      args,
      { cwd, env, timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // synctex prints usable results even when it exits non-zero.
        if (error && !stdout) return reject(error);
        resolve(String(stdout));
      },
    );
  });
}

/**
 * @param {object} options
 * @param {string} options.projectRoot absolute path of the project folder
 * @param {{rootDir: string, pdfPath: string}} options.target
 * @param {string} [options.texBinDir]
 */
async function prepare({ target, texBinDir }) {
  const tex = await resolveTexEnvironment({ customBinDir: texBinDir });
  if (!tex.synctex) {
    throw new Error("synctex was not found in your TeX installation");
  }
  return {
    synctex: tex.synctex,
    env: { ...process.env, PATH: tex.PATH },
    target,
  };
}

/** Source position -> rectangles in the PDF. */
async function syncFromCode({
  projectRoot,
  target,
  texBinDir,
  file,
  line,
  column,
}) {
  const { synctex, env } = await prepare({ target, texBinDir });
  const inputPath = Path.resolve(projectRoot, file);
  const stdout = await run(
    synctex,
    ["view", "-i", `${line}:${column}:${inputPath}`, "-o", target.pdfPath],
    target.rootDir,
    env,
  );
  return parseViewOutput(stdout);
}

/** Position in the PDF -> source file and line. */
async function syncFromPdf({ projectRoot, target, texBinDir, page, h, v }) {
  const { synctex, env } = await prepare({ target, texBinDir });
  const stdout = await run(
    synctex,
    ["edit", "-o", `${page}:${h}:${v}:${target.pdfPath}`],
    target.rootDir,
    env,
  );
  return parseEditOutput(stdout, projectRoot, target.rootDir);
}

module.exports = {
  syncFromCode,
  syncFromPdf,
  parseViewOutput,
  parseEditOutput,
};
