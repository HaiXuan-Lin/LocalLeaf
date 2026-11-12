"use strict";
// LocalLeaf has to fit the Overleaf it is checked out with: this is the same
// check build.sh runs (see desktop/UPGRADING.md).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Path = require("node:path");
const { spawnSync } = require("node:child_process");

const DESKTOP_DIR = Path.join(__dirname, "..");
const SCRIPT = Path.join(DESKTOP_DIR, "scripts", "check-upstream.js");

test("LocalLeaf fits the checked-out Overleaf", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--quiet"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("upstream.json names files that exist and a full commit id", () => {
  const manifest = JSON.parse(
    fs.readFileSync(Path.join(DESKTOP_DIR, "upstream.json"), "utf8"),
  );
  assert.match(manifest.base.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.base.date, /^\d{4}-\d{2}-\d{2}$/);
  const repo = Path.join(DESKTOP_DIR, "..");
  for (const kind of ["ported", "contract", "build"]) {
    for (const entry of manifest[kind]) {
      const local = entry.local.split(" ")[0];
      assert.ok(fs.existsSync(Path.join(repo, local)), `${local} is missing`);
      assert.ok(entry.what, `${entry.upstream} has no description`);
    }
  }
});
