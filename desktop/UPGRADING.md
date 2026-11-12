# Keeping LocalLeaf up to date with Overleaf

LocalLeaf is built to follow Overleaf: when Overleaf's editor gains a feature,
merging the newer Overleaf brings it into LocalLeaf, usually without further
work. This file describes how the two fit together, how to update, and what to
do when an update needs attention.

## How LocalLeaf sits on top of Overleaf

This repository is the Overleaf repository plus a small, separate layer:

| LocalLeaf's own files                 |                                                           |
| ------------------------------------- | --------------------------------------------------------- |
| `desktop/`                            | the app: local backend, packaging, tests, these documents |
| `services/web/modules/desktop/`       | the front-end side, an ordinary Overleaf module           |
| `build.sh`, `install.sh`              | entry points                                              |
| `README.md`, `NOTICE`, `CITATION.cff` | project documents (`README.md` replaces Overleaf's)       |
| `.gitignore`                          | Overleaf's file with a few lines added at the end         |

No other file of Overleaf is edited. Everything LocalLeaf changes about the
editor happens at build time, through four mechanisms that are all listed in
one place each:

1. **Module slots** — `services/web/modules/desktop/settings.desktop.js`.
   Overleaf's own extension mechanism (`importOverleafModules`).
2. **Replaced modules** — `services/web/modules/desktop/replacements.js`.
   A table "Overleaf front-end module → desktop version". The eight entries
   remove what needs a server (sharing, history, collaborators) and adapt the
   toolbar.
3. **Page data and feature switches** — `desktop/main/server/html.js` renders
   the `ol-*` meta tags the editor reads; `ProjectSession.projectView()`
   decides which `features` are on.
4. **A few CSS rules** — `services/web/modules/desktop/frontend/stylesheets/desktop.scss`.

The backend (`desktop/main/`) implements the part of Overleaf's servers that
the editor talks to: HTTP requests (`server/Api.js`), socket.io events
(`project/ProjectSession.js`), compiling (`project/Compiler.js`).

`desktop/upstream.json` records the Overleaf commit LocalLeaf is based on and
every Overleaf file that LocalLeaf replaces, reuses unchanged, has ported
logic from, or relies on as the contract between editor and servers.

## Updating

```sh
# 1. What would the update mean? (changes nothing)
desktop/scripts/update-from-overleaf.sh --check

# 2. Merge it
desktop/scripts/update-from-overleaf.sh

# 3. Build and test
./build.sh
(cd desktop && npm test)
```

A branch, tag or commit of Overleaf can be given as an argument; the default
is `main`. The script fetches from a git remote that points at
`github.com/overleaf/overleaf` if there is one, and from the URL otherwise.

Step 2 merges Overleaf into the current branch, keeps LocalLeaf's `README.md`,
records the new base in `desktop/upstream.json` and commits. If LocalLeaf does
not fit the new version, the merge is left staged but uncommitted, with a list
of what to adapt; `git merge --abort` undoes it.

Overleaf publishes its public repository in batches, so `main` may not move for
weeks.

## Reading the report

`update-from-overleaf.sh --check` (or `node desktop/scripts/check-upstream.js
--against <commit>`) prints two things.

**Whether LocalLeaf fits.** These are hard requirements; `build.sh` checks them
too and stops before installing any package:

| Message                                           | What to do                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `… no longer exists` (replaced)                   | The module was moved or renamed. Find its new place and update the key in `replacements.js`.                                                                           |
| `… exports X which … does not provide`            | Overleaf added an export to a replaced module. Add it to the desktop version (for a removed feature usually a component returning `null` or a hook with fixed values). |
| `… no longer exists` (reused / ported / contract) | Find the new location and update the path in `desktop/main/util/vendor.js` or `desktop/upstream.json`.                                                                 |
| `the module slot "…" is no longer used`           | The extension point was renamed or removed. Pick the new one in `settings.desktop.js` (the report lists added and removed slots).                                      |

**What changed since the recorded base.** These are things to look at, not
errors:

- _Changed files that LocalLeaf depends on_, grouped by kind, each with the
  local file to compare and a ready `git diff` command.
  - `replaced`: if the desktop version was derived from the original
    (`toolbar/menu-bar.tsx`, `toolbar/project-title.tsx`,
    `context/permissions-context.tsx`), carry over what is useful.
  - `reused`: nothing to do unless the build or tests fail.
  - `ported`: compare the change with the local port (for example new latexmk
    flags in `LatexRunner.js` → `Compiler.js`).
  - `contract`: see the next points.
- _New requests in the editor's code_, marked `handled by Api.js` or `not
handled`. An unhandled request matters only if it belongs to a feature that
  LocalLeaf keeps: add a route to `desktop/main/server/Api.js`. Requests of
  removed features (sharing, history, subscriptions) can be ignored.
- _New socket.io events_: add a `case` in `ProjectSession.handleSocketEvent`.
- _New page data (meta tags)_, marked when `html.js` does not render them. The
  editor treats a missing tag as `undefined`; add it when a kept feature needs
  it.
- _New / removed module slots_: new places where LocalLeaf could add or hide
  something without replacing a module.
- _Toolchain_: `build.sh` reads the Node.js and Yarn versions from Overleaf's
  `package.json`, so they follow by themselves.

## After the merge

1. `./build.sh` — runs the same fit check, then webpack. An import error in
   `services/web/modules/desktop/` means an Overleaf component used by a
   desktop file was moved or renamed.
2. `cd desktop && npm test` — the backend tests (file tree, OT, API, compile).
3. Run the app with logging and click through the editor:

   ```sh
   LOCALLEAF_DEBUG=1 desktop/dist/LocalLeaf.app/Contents/MacOS/LocalLeaf path/to/a/latex/folder
   ```

   Every request and socket event the backend does not know is printed
   (`[404] …`, `[socket] unhandled event: …`). Nothing leaves the computer
   either way: the app blocks all network access.

4. Decide about new features. A feature that works on local files usually
   works at once. A feature that needs Overleaf's servers shows up as a
   button that does nothing or as `[404]` lines: either implement the request
   in `Api.js`, or hide the feature — switch it off in `projectView().features`
   or the split-test list in `webpack.config.desktop.js`, or replace its
   entry-point component in `replacements.js`.
5. If Overleaf added a file whose name LocalLeaf also uses, or if a new
   upstream file should always keep LocalLeaf's version on merges, add it to
   `keepOursOnMerge` in `desktop/upstream.json`.

## Rules that keep updates cheap

- Do not edit Overleaf's files. Use a module slot if one exists, a replaced
  module otherwise, CSS as a last resort.
- When a desktop file is derived from an Overleaf file, or ports its logic,
  list the original in `replacements.js` or under `ported` in
  `desktop/upstream.json`, so that the report notices changes.
- Keep replaced modules small: replace the entry point of a feature, not the
  feature.
- New backend behaviour gets a test in `desktop/test/`.
