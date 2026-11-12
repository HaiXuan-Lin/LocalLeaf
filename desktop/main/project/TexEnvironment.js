"use strict";
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const { execFile } = require("node:child_process");

/**
 * Finds the user's own TeX installation.
 *
 * The app does not ship TeX. A macOS app started from Finder or the Dock gets
 * a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the usual install
 * locations are searched and the PATH of the user's login shell is added.
 */

function listDirs(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => Path.join(parent, entry.name));
  } catch {
    return [];
  }
}

function wellKnownTexDirs() {
  const home = os.homedir();
  const dirs = ["/Library/TeX/texbin"];
  // TeX Live: /usr/local/texlive/<year>/bin/<platform>, newest first
  for (const root of ["/usr/local/texlive", Path.join(home, "texlive")]) {
    const years = listDirs(root).sort().reverse();
    for (const year of years) {
      dirs.push(...listDirs(Path.join(year, "bin")));
    }
  }
  // TinyTeX
  for (const root of [
    Path.join(home, "Library/TinyTeX/bin"),
    Path.join(home, ".TinyTeX/bin"),
  ]) {
    dirs.push(...listDirs(root));
  }
  dirs.push(
    "/opt/homebrew/bin", // Homebrew on Apple silicon
    "/usr/local/bin", // Homebrew on Intel, manual installs
    "/opt/local/bin", // MacPorts
    "/usr/texbin", // old MacTeX
    Path.join(home, "bin"),
    Path.join(home, ".local/bin"),
  );
  return dirs;
}

let loginShellPathPromise = null;

/** PATH as the user's login shell sees it (cached; best effort). */
function loginShellPath() {
  if (loginShellPathPromise) return loginShellPathPromise;
  loginShellPathPromise = new Promise((resolve) => {
    if (process.platform === "win32") return resolve("");
    const shell = process.env.SHELL || "/bin/zsh";
    const marker = "__LOCALLEAF_PATH__";
    execFile(
      shell,
      ["-ilc", `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`],
      { timeout: 5000, encoding: "utf8", env: process.env },
      (_error, stdout) => {
        const match = String(stdout || "").match(
          new RegExp(`${marker}(.*?)${marker}`, "s"),
        );
        resolve(match ? match[1].trim() : "");
      },
    );
  });
  return loginShellPathPromise;
}

function isExecutableFile(path) {
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) return false;
    fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(name, dirs) {
  for (const dir of dirs) {
    const candidate = Path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {object} [options]
 * @param {string} [options.customBinDir] a directory chosen by the user
 * @return {Promise<{PATH: string, dirs: string[], latexmk: string|null, synctex: string|null}>}
 */
async function resolveTexEnvironment({ customBinDir } = {}) {
  const shellPath = await loginShellPath();
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };
  if (customBinDir) add(customBinDir);
  // The login shell's PATH comes first: it reflects which TeX the user uses
  // in their terminal when more than one is installed.
  shellPath.split(Path.delimiter).forEach(add);
  wellKnownTexDirs().forEach(add);
  (process.env.PATH || "").split(Path.delimiter).forEach(add);
  const existing = dirs.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  return {
    PATH: existing.join(Path.delimiter),
    dirs: existing,
    latexmk: findExecutable("latexmk", existing),
    synctex: findExecutable("synctex", existing),
  };
}

/** For tests and for "Re-detect TeX" after the user installs it. */
function resetCache() {
  loginShellPathPromise = null;
}

module.exports = { resolveTexEnvironment, findExecutable, resetCache };
