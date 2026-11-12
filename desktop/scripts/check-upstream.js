#!/usr/bin/env node
"use strict";
/**
 * Checks LocalLeaf against the Overleaf code it is built on.
 *
 *   node desktop/scripts/check-upstream.js
 *       Static checks of the checked-out tree (no git needed; build.sh runs
 *       this): every Overleaf file LocalLeaf replaces, reuses, ports or
 *       extends is still there, the module slots are still used, and the
 *       replaced front-end modules still export what the rest of the editor
 *       imports from them.
 *
 *   node desktop/scripts/check-upstream.js --since
 *       Also reports what changed in those files, and in the contract between
 *       editor and servers (requests, socket events, page data, module
 *       slots), between the recorded base commit and the checked-out tree.
 *
 *   node desktop/scripts/check-upstream.js --against <ref>
 *       The same report for an Overleaf commit that is fetched but not merged
 *       yet (for example FETCH_HEAD or overleaf/main): what to expect from an
 *       update. Nothing in the working tree is changed.
 *
 *   --base <ref>   compare from this commit instead of the recorded base
 *   --quiet        print problems only
 *
 * The list of touchpoints lives in desktop/upstream.json,
 * services/web/modules/desktop/replacements.js and
 * desktop/main/util/vendor.js. See desktop/UPGRADING.md.
 */
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const { execFileSync } = require("node:child_process");

const DESKTOP_DIR = Path.join(__dirname, "..");
const REPO_DIR = Path.join(DESKTOP_DIR, "..");
const MODULE_DIR = "services/web/modules/desktop";
const FRONTEND_JS = "services/web/frontend/js";

const manifest = JSON.parse(
  fs.readFileSync(Path.join(DESKTOP_DIR, "upstream.json"), "utf8"),
);
const replacements = require(
  Path.join(REPO_DIR, MODULE_DIR, "replacements.js"),
);
const { SOURCES } = require(Path.join(DESKTOP_DIR, "main/util/vendor.js"));

// ------------------------------------------------------------------ options

const args = process.argv.slice(2);
const options = { since: false, against: null, base: null, quiet: false };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--since") options.since = true;
  else if (arg === "--against") options.against = args[++i];
  else if (arg.startsWith("--against=")) options.against = arg.slice(10);
  else if (arg === "--base") options.base = args[++i];
  else if (arg.startsWith("--base=")) options.base = arg.slice(7);
  else if (arg === "--quiet") options.quiet = true;
  else if (arg === "-h" || arg === "--help") {
    const source = fs.readFileSync(__filename, "utf8");
    const comment = source.slice(source.indexOf("/**"), source.indexOf("*/"));
    console.log(comment.replace(/^\/?\s?\*+\s?/gm, "").trim());
    process.exit(0);
  } else {
    console.error(`unknown option: ${arg}`);
    process.exit(2);
  }
}
for (const name of ["against", "base"]) {
  if (args.includes(`--${name}`) && !options[name]) {
    console.error(`--${name} needs a commit, branch or tag`);
    process.exit(2);
  }
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (text) => paint("1", text);
const red = (text) => paint("31", text);
const yellow = (text) => paint("33", text);
const green = (text) => paint("32", text);
const dim = (text) => paint("2", text);

// ---------------------------------------------------------------------- git

function git(gitArgs, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", gitArgs, {
      cwd: REPO_DIR,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(
      `git ${gitArgs.join(" ")} failed: ${String(error.stderr || error.message).trim()}`,
    );
  }
}

function resolveCommit(ref) {
  const out = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    allowFailure: true,
  });
  return out ? out.trim() : null;
}

const temporaryDirs = [];
process.on("exit", () => {
  for (const dir of temporaryDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A tree to inspect: the working tree, or a commit of which the relevant
 * directories are unpacked into a temporary folder. Both are then read with
 * the same code.
 */
function openTree(ref) {
  if (!ref) return { root: REPO_DIR, label: "working tree", commit: null };
  const commit = resolveCommit(ref);
  if (!commit) throw new Error(`unknown commit: ${ref}`);
  const wanted = new Set([
    FRONTEND_JS,
    "services/web/app/src/router.mjs",
    "services/web/modules",
    "services/real-time/app/js",
    "package.json",
    ...upstreamPaths().map((entry) => entry.upstream),
  ]);
  const present = [...wanted].filter(
    (path) =>
      git(["cat-file", "-e", `${commit}:${path}`], { allowFailure: true }) !==
      null,
  );
  const root = fs.mkdtempSync(Path.join(os.tmpdir(), "localleaf-upstream-"));
  temporaryDirs.push(root);
  const archive = execFileSync(
    "git",
    ["archive", "--format=tar", commit, "--", ...present],
    { cwd: REPO_DIR, maxBuffer: 1024 * 1024 * 1024 },
  );
  execFileSync("tar", ["-x", "-C", root], { input: archive });
  return { root, label: commit.slice(0, 10), commit };
}

// ---------------------------------------------------------------- the lists

const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

/** Path of a front-end module given without extension, or null. */
function resolveModule(root, pathWithoutExtension) {
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = pathWithoutExtension + extension;
    if (fs.existsSync(Path.join(root, candidate))) return candidate;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = Path.posix.join(
      pathWithoutExtension,
      "index" + extension,
    );
    if (fs.existsSync(Path.join(root, candidate))) return candidate;
  }
  return null;
}

function replacedModules(root) {
  return Object.entries(replacements).map(([original, replacement]) => {
    const base = Path.posix.join(FRONTEND_JS, original);
    return {
      kind: "replaced",
      upstream: resolveModule(root, base) || base,
      found: resolveModule(root, base) !== null,
      local: Path.posix.join(
        MODULE_DIR,
        "frontend/js/replacements",
        replacement,
      ),
      what: "replaced at build time",
    };
  });
}

/** Every Overleaf file LocalLeaf depends on, with the local file to review. */
function upstreamPaths(root = REPO_DIR) {
  const entries = [...replacedModules(root)];
  for (const [name, source] of Object.entries(SOURCES)) {
    if (!source) continue;
    entries.push({
      kind: "reused",
      upstream: source,
      local: `desktop/main/util/vendor.js (${name})`,
      what: "loaded unchanged by the backend",
    });
  }
  for (const kind of ["ported", "contract", "build"]) {
    for (const entry of manifest[kind]) entries.push({ kind, ...entry });
  }
  return entries;
}

// ------------------------------------------------------------ reading trees

function walk(root, dir, visit) {
  const absolute = Path.join(root, dir);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = Path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(root, relative, visit);
    } else if (SOURCE_EXTENSIONS.includes(Path.extname(entry.name))) {
      visit(relative);
    }
  }
}

function read(root, path) {
  try {
    return fs.readFileSync(Path.join(root, path), "utf8");
  } catch {
    return null;
  }
}

function matchAll(text, regex, group = 1) {
  const found = new Set();
  if (!text) return found;
  for (const match of text.matchAll(regex)) found.add(match[group]);
  return found;
}

/** Everything the report compares between two versions of Overleaf. */
function describe(tree) {
  const { root } = tree;
  const info = {
    metas: new Set(),
    slots: new Set(),
    requests: new Set(),
    routes: new Set(),
    socketEvents: new Set(),
    versions: {},
  };

  walk(root, FRONTEND_JS, (path) => {
    const text = read(root, path);
    for (const name of matchAll(text, /getMeta\(\s*['"](ol-[\w-]+)['"]/g)) {
      info.metas.add(name);
    }
    for (const name of matchAll(
      text,
      /importOverleafModules\(\s*['"]([\w-]+)['"]/g,
    )) {
      info.slots.add(name);
    }
    for (const match of text.matchAll(
      /\b(getJSON|postJSON|putJSON|deleteJSON|fetchJSON|fetchNothing|fetchString|fetchData)\s*(?:<[^>()]*>)?\(\s*[`'"](\/[^`'"\s]*)[`'"]/g,
    )) {
      const method =
        { postJSON: "POST", putJSON: "PUT", deleteJSON: "DELETE" }[match[1]] ||
        "GET";
      info.requests.add(`${method} ${normalizeUrl(match[2])}`);
    }
  });

  const routers = ["services/web/app/src/router.mjs"];
  walk(root, "services/web/modules", (path) => {
    if (/Router\.m?js$/.test(path) && !path.startsWith(MODULE_DIR)) {
      routers.push(path);
    }
  });
  for (const path of routers) {
    const text = read(root, path) || "";
    for (const match of text.matchAll(
      /\b\w*[rR]outer\.(get|post|put|delete|patch|head)\(\s*['"`](\/[^'"`]*)['"`]/g,
    )) {
      info.routes.add(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }

  info.socketEvents = matchAll(
    read(root, "services/real-time/app/js/Router.js"),
    /client\.on\(\s*['"]([\w.-]+)['"]/g,
  );

  const packageJson = read(root, "package.json");
  if (packageJson) {
    const parsed = JSON.parse(packageJson);
    info.versions = {
      node: parsed.engines?.node,
      packageManager: parsed.packageManager,
    };
  }
  return info;
}

function normalizeUrl(url) {
  return (
    url
      .replace(/\?.*$/, "")
      .replace(/\$\{[^}]*\}/g, ":x")
      .replace(/\/+$/, "") || "/"
  );
}

// ------------------------------------------------- what LocalLeaf implements

function localRoutes() {
  const text = read(REPO_DIR, "desktop/main/server/Api.js") || "";
  const routes = [];
  for (const match of text.matchAll(
    /\broute\(\s*["'](\w+)["'],\s*["']([^"']+)["']/g,
  )) {
    const source = match[2]
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/:\w+/g, "[^/]+");
    routes.push({ method: match[1], regex: new RegExp(`^${source}$`) });
  }
  return routes;
}

function isImplemented(routes, request) {
  const [method, url] = request.split(" ");
  const sample = url.replace(/:x/g, "x");
  return routes.some(
    (route) => route.method === method && route.regex.test(sample),
  );
}

function localMetas() {
  return matchAll(
    read(REPO_DIR, "desktop/main/server/html.js"),
    /["'`](ol-[\w-]+)["'`]/g,
  );
}

function localSocketEvents() {
  return matchAll(
    read(REPO_DIR, "desktop/main/project/ProjectSession.js"),
    /case\s+["']([\w.-]+)["']\s*:/g,
  );
}

function usedSlots() {
  const settingsPath = Path.join(REPO_DIR, MODULE_DIR, "settings.desktop.js");
  const settings = require(settingsPath);
  return Object.entries(settings.overleafModuleImports || {})
    .filter(([, modules]) => Array.isArray(modules) && modules.length > 0)
    .map(([name]) => name);
}

/** Names a module exports (a rough but sufficient reading of the source). */
function exportedNames(text) {
  const names = new Set();
  if (!text) return names;
  for (const match of text.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(",")) {
      const item = part.trim();
      if (!item || item.startsWith("type ")) continue;
      const name = item
        .split(/\s+as\s+/)
        .pop()
        .trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default\b/m.test(text)) names.add("default");
  return names;
}

// ------------------------------------------------------------ static checks

function staticChecks(tree) {
  const problems = [];
  const { root } = tree;

  for (const entry of upstreamPaths(root)) {
    const exists =
      entry.kind === "replaced"
        ? entry.found
        : fs.existsSync(Path.join(root, entry.upstream));
    if (!exists) {
      problems.push(
        `${entry.upstream} no longer exists\n` +
          `      ${entry.kind}: ${entry.what}\n` +
          `      review ${entry.local}`,
      );
    }
  }

  // Replaced modules must keep offering what the editor imports from them.
  for (const entry of replacedModules(root)) {
    if (!entry.found) continue;
    const upstream = exportedNames(read(root, entry.upstream));
    const local = exportedNames(read(REPO_DIR, entry.local));
    const missing = [...upstream].filter((name) => !local.has(name));
    if (missing.length > 0) {
      problems.push(
        `${entry.upstream} exports ${missing.join(", ")}\n` +
          `      which ${entry.local} does not provide`,
      );
    }
  }

  // Module slots that LocalLeaf fills must still be read by the front end.
  const slots = describe(tree).slots;
  for (const slot of usedSlots()) {
    if (!slots.has(slot)) {
      problems.push(
        `the module slot "${slot}" is no longer used by the editor\n` +
          `      review ${MODULE_DIR}/settings.desktop.js`,
      );
    }
  }
  return problems;
}

// -------------------------------------------------------------- diff report

function difference(before, after) {
  return {
    added: [...after].filter((item) => !before.has(item)).sort(),
    removed: [...before].filter((item) => !after.has(item)).sort(),
  };
}

function printList(title, items, format = (item) => item) {
  if (items.length === 0) return;
  console.log(`\n${bold(title)}`);
  for (const item of items) console.log(`  ${format(item)}`);
}

function report(baseCommit, targetTree, targetRef) {
  const baseTree = openTree(baseCommit);
  const before = describe(baseTree);
  const after = describe(targetTree);
  const range = targetRef ? `${baseCommit}..${targetRef}` : baseCommit;
  const count = targetRef
    ? git(["rev-list", "--count", `${baseCommit}..${targetRef}`], {
        allowFailure: true,
      })
    : null;

  console.log(
    `\n${bold("Changes in Overleaf")} from ${baseTree.label} to ${targetTree.label}` +
      (count ? ` (${count.trim()} commits)` : ""),
  );

  // 1. files LocalLeaf depends on
  const changed = [];
  for (const entry of upstreamPaths(targetTree.root)) {
    const a = read(baseTree.root, entry.upstream);
    const b = read(targetTree.root, entry.upstream);
    if (a !== b) changed.push(entry);
  }
  if (changed.length === 0) {
    console.log(
      `\n${green("No file that LocalLeaf replaces, reuses or ports was changed.")}`,
    );
  } else {
    console.log(
      `\n${bold("Changed files that LocalLeaf depends on")} — compare each with the local file:`,
    );
    for (const kind of ["replaced", "reused", "ported", "contract", "build"]) {
      const entries = changed.filter((entry) => entry.kind === kind);
      if (entries.length === 0) continue;
      console.log(`\n  ${yellow(kind)}`);
      for (const entry of entries) {
        console.log(`    ${entry.upstream}`);
        console.log(dim(`      ${entry.what}; review ${entry.local}`));
        console.log(dim(`      git diff ${range} -- ${entry.upstream}`));
      }
    }
  }

  // 2. requests the editor makes
  const routes = localRoutes();
  const requests = difference(before.requests, after.requests);
  printList("New requests in the editor's code", requests.added, (request) =>
    isImplemented(routes, request)
      ? `${request}  ${green("handled by Api.js")}`
      : `${request}  ${yellow("not handled")}`,
  );
  printList("Requests the editor no longer makes", requests.removed);

  // 3. server routes (a new route often comes with a new feature)
  const serverRoutes = difference(before.routes, after.routes);
  printList("New routes in Overleaf's web service", serverRoutes.added);
  printList("Removed routes", serverRoutes.removed);

  // 4. socket events
  const handled = localSocketEvents();
  const events = difference(before.socketEvents, after.socketEvents);
  printList(
    "New socket.io events accepted by real-time",
    events.added,
    (name) => (handled.has(name) ? name : `${name}  ${yellow("not handled")}`),
  );
  printList("Removed socket.io events", events.removed);

  // 5. page data
  const rendered = localMetas();
  const metas = difference(before.metas, after.metas);
  printList(
    "New page data (meta tags) read by the front end",
    metas.added,
    (name) =>
      rendered.has(name)
        ? name
        : `${name}  ${yellow("not rendered by html.js")}`,
  );
  printList("Meta tags no longer read", metas.removed);

  // 6. extension points
  const slots = difference(before.slots, after.slots);
  printList("New module slots (extension points)", slots.added);
  printList("Removed module slots", slots.removed);

  // 7. toolchain
  for (const key of ["node", "packageManager"]) {
    if (before.versions[key] !== after.versions[key]) {
      console.log(
        `\n${bold("Toolchain")}: ${key} ${before.versions[key]} -> ${after.versions[key]} (build.sh follows automatically)`,
      );
    }
  }
  console.log("");
}

// --------------------------------------------------------------------- main

function main() {
  const targetTree = openTree(options.against);

  const problems = staticChecks(targetTree);
  if (problems.length > 0) {
    console.error(
      red(
        `LocalLeaf does not fit this version of Overleaf (${targetTree.label}):`,
      ),
    );
    for (const problem of problems) console.error(`\n  - ${problem}`);
    console.error("\nSee desktop/UPGRADING.md.\n");
  } else if (!options.quiet) {
    const total = upstreamPaths(targetTree.root).length;
    console.log(
      green(
        `LocalLeaf fits Overleaf ${targetTree.label}: ${total} files it depends on are present, replaced modules and module slots match.`,
      ),
    );
  }

  if (options.since || options.against || options.base) {
    const wanted = options.base || manifest.base.commit;
    const base = resolveCommit(wanted);
    if (!base) {
      console.error(
        yellow(
          `The base commit ${wanted.slice(0, 10)} is not in this repository (shallow clone or no git): no change report.`,
        ),
      );
    } else {
      report(base, targetTree, options.against ? targetTree.commit : null);
    }
  }

  process.exitCode = problems.length > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(red(`error: ${error.message}`));
  process.exitCode = 2;
}
