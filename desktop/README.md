# LocalLeaf: building, using and how it works

This is the detailed guide. The overview, and LocalLeaf's relationship to
Overleaf, are in the [README](../README.md) at the top of the repository.

LocalLeaf is a native macOS application built from this repository. It is the
Overleaf Community Edition editor (the same React/CodeMirror front end, PDF
viewer, log viewer and SyncTeX) with everything that needs a server cut away.
You open a folder on your Mac and work in it, as you would in TeXstudio:

- files are read from and saved to that folder, nothing is uploaded;
- documents are compiled with **your own TeX installation** (MacTeX / TeX
  Live, through `latexmk`) — the app does not contain TeX;
- no account, no network connection, no Docker, MongoDB or Redis.

LocalLeaf is an independent fork. It is not affiliated with or endorsed by
Overleaf. "Overleaf" is a trademark of its owner; the name and logo are not
used in the app.

## Build and install

```sh
./build.sh      # builds desktop/dist/LocalLeaf.app from source
./install.sh    # copies it to /Applications
```

Requirements:

- macOS 13 or later (Apple silicon or Intel) with `git`
  (`xcode-select --install`);
- an internet connection **while building**: npm packages and the Electron
  runtime are downloaded once. The finished app never uses the network;
- about 4 GB of free disk space for the build.

`build.sh` uses Node.js ≥ 24.18 if you have it and otherwise downloads one into
`desktop/.toolchain/`. Nothing is installed outside the repository. The first
build takes 10–20 minutes, most of it downloading and bundling the editor.

Useful options (`./build.sh --help`, `./install.sh --help`):

| Command                                          | Effect                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `./build.sh --dictionaries en_US,en_GB,de_DE,fr` | choose the spell-check languages to bundle (default: English; `all` adds ~270 MB) |
| `./build.sh --arch x64` / `universal`            | build for another CPU architecture                                                |
| `./build.sh --skip-install`                      | rebuild without reinstalling packages                                             |
| `./build.sh --clean`                             | start from scratch                                                                |
| `./install.sh --user`                            | install into `~/Applications`                                                     |
| `./install.sh --open`                            | start the app after installing                                                    |
| `./install.sh --uninstall [--purge]`             | remove the app (and its settings)                                                 |

Behind a slow connection or a mirror, these environment variables are
honoured: `NODEJS_ORG_MIRROR`, `YARN_NPM_REGISTRY_SERVER`,
`npm_config_registry`, `ELECTRON_MIRROR`.

The app is signed ad hoc, which is what a locally built app needs to run on
the Mac that built it. To give the app to other people it has to be signed
with a Developer ID and notarised.

The installed app is roughly 280 MB; about 250 MB of that is the Electron
(Chromium) runtime, the editor itself is about 25 MB.

## Using it

- **Open a folder**: _File ▸ Open Folder…_ (⌘O), the start page, drop a folder
  on the Dock icon, or `open -a LocalLeaf path/to/folder`. Each folder gets its
  own window. Recent folders are on the start page and in _File ▸ Open Recent_.
- **Edit**: changes are saved to disk automatically within about two seconds of
  typing; there is no Save command. Files changed by another program (git, a
  script that regenerates a figure, another editor) are picked up while they
  are open.
- **Compile**: _Recompile_ or ⌘S / ⌘↵ runs `latexmk` in the folder of the main
  document. The PDF, `.aux`, `.log`, `.synctex.gz`, … are written next to the
  source, exactly as when you run `latexmk` in a terminal. Build by-products
  are hidden from the file tree; the PDF is shown.
  - Compiler (pdfLaTeX, XeLaTeX, LuaLaTeX, LaTeX) and main document are set in
    _Settings ▸ Compiler_ and remembered per folder. For a new folder the
    compiler is guessed from a `% !TEX program = …` line or from packages such
    as `fontspec`, `xeCJK` and `ctex`.
  - If the file you are editing has its own `\documentclass`, that file is
    compiled (several main files in one folder work).
  - A `latexmkrc` / `.latexmkrc` in the folder is respected.
  - _Clear cached files_ in the log pane runs `latexmk -c` and removes the
    remaining by-products; the PDF is kept.
- **SyncTeX**: double-click in the PDF to jump to the source; the arrow buttons
  between editor and PDF go both ways.
- **TeX installation**: found in `/Library/TeX/texbin`,
  `/usr/local/texlive/*/bin/*`, TinyTeX, Homebrew, MacPorts and the `PATH` of
  your login shell. Choose another folder in _LocalLeaf ▸ TeX Distribution…_ or
  _Settings ▸ Editor ▸ TeX distribution_. Without TeX the editor still works
  and the log pane says what is missing.
- **PDF in its own window**: layout button (top right) ▸ _Open PDF in separate
  tab_.
- **Interface language**: _LocalLeaf ▸ Language_ (all of Overleaf's
  translations; the few desktop-only labels are English).
- **Deleting** a file in the tree moves it to the Trash.

Settings, recent folders and learned words live in
`~/Library/Application Support/LocalLeaf/`. Nothing is written into a project
folder except what you edit and what TeX produces.

## What was removed from Overleaf

Sign-up and login, the project dashboard, sharing and link sharing,
collaborators and their cursors, chat, comments and track changes, history and
labelled versions, project copy/templates/submission, Dropbox, GitHub and
git-bridge integration, reference manager integrations, linked files from URLs
or other projects, subscriptions and upgrade prompts, analytics and error
reporting, the Python runner, AI features, admin pages.

Kept: the source and visual editors, autocomplete (commands, `\ref`, `\cite`,
packages), spell check, file tree with upload/drag and drop, file outline,
project-wide search, the PDF viewer, log viewer with hints, SyncTeX, word
count, symbol palette, keybindings (Vim/Emacs), themes, the detached PDF
window, all interface translations.

## How it works

```
build.sh, install.sh                 entry points
desktop/
  main/                              Electron main process = the local backend
    main.js, DesktopApp.js, Menu.js    windows, menus, localleaf:// protocol
    server/                            the HTTP API the editor calls + page HTML
    project/                           one opened folder:
      ProjectTree.js                     folder <-> Overleaf file tree, watcher
      Documents.js                       joinDoc / OT updates <-> files on disk
      Compiler.js, Synctex.js            latexmk and synctex from your TeX
      Snapshot.js, Metadata.js           data for search, word count, autocomplete
  preload/preload.js                 the only bridge between page and backend
  shims/socket.io.js                 stands in for the socket.io client
  scripts/                           staging and packaging
  test/                              tests of the backend (node --test)
services/web/modules/desktop/        the front-end side, an Overleaf "module"
  webpack.config.desktop.js            builds only the editor pages
  settings.desktop.js                  module slots used by the desktop app
  replacements.js                      upstream modules swapped at build time
  frontend/js/                         start page, desktop components, replacements
```

Overleaf's editor expects a web server, a websocket service, a document
updater, a compile service and two databases. Here one process plays all of
them for a single user:

- Pages and assets are served from the app bundle through a private
  `localleaf://` scheme. All `http(s)`/`ws(s)` requests are blocked, so the
  app cannot talk to the network even by accident.
- The editor's configuration is rendered into the page as `<meta>` tags, as
  Overleaf's web service does (`main/server/html.js`).
- The editor believes it has a socket.io connection. `shims/socket.io.js`
  forwards its events over Electron IPC to `ProjectSession`, which answers
  `joinProject`, `joinDoc` and `applyOtUpdate` and pushes file-tree events.
- Documents use the same operational-transformation text type as Overleaf's
  document-updater (`services/document-updater/app/js/sharejs/types/text.js`,
  reused unchanged). Every applied update is written to the file at once. A
  change made on disk by another program becomes an OT update for the editor.
- The file tree is a mirror of the folder, kept current with a recursive file
  watcher. Ids are derived from paths, so "last opened file" and layout
  survive restarts.
- Compiling runs `latexmk` with the same flags as Overleaf's CLSI service
  (`-synctex=1 -interaction=batchmode -f`, compiler flag), in place. Each
  build's PDF and log are copied to a per-build cache so the viewer never
  reads a half-written file.

Only three kinds of change touch upstream code, all at build time and all
listed in `services/web/modules/desktop/`: module slots (Overleaf's own
extension mechanism), a short table of replaced modules (`replacements.js`;
the build fails if a replaced file disappears upstream), and a few CSS rules.
No upstream source file is edited (only `.gitignore` gains a few lines, and
the top-level `README.md` is LocalLeaf's), which keeps merges from upstream
simple.

### Following Overleaf

`desktop/upstream.json` records the Overleaf commit LocalLeaf is based on and
every Overleaf file it replaces, reuses, has ported logic from or relies on.
`desktop/scripts/check-upstream.js` verifies that LocalLeaf still fits the
checked-out Overleaf (`build.sh` runs it) and can report what changed in a
newer one; `desktop/scripts/update-from-overleaf.sh` merges a newer Overleaf.
See [UPGRADING.md](UPGRADING.md).

### Working on it

```sh
# backend tests (plain Node; the compile test needs TeX on the PATH)
cd desktop && npm test

# run from source against a development build of the editor
LOCALLEAF_DEV=1 yarn workspace @overleaf/web exec webpack \
  --config modules/desktop/webpack.config.desktop.js
cd desktop && LOCALLEAF_DEBUG=1 npx electron . path/to/folder
```

`LOCALLEAF_DEBUG=1` logs requests and socket events the backend does not handle;
`LOCALLEAF_USER_DATA=<dir>` uses a separate settings folder.

## Limitations

- Files must be UTF-8 to be edited. Files in other encodings (Latin-1, GBK)
  are listed and previewed but opened read-only as plain files.
- Text files larger than 2 MB are treated as read-only files.
- There is no version history: use git in the folder.
- Characters outside the Basic Multilingual Plane (emoji) typed in the editor
  are replaced, as on overleaf.com; existing ones in a file are preserved.
- Very large folders (more than 20 000 entries) are only partly shown: open
  the project folder, not a parent of it.
- The build output directory cannot be changed in the app; use a `latexmkrc`
  if you need one (the in-app PDF viewer expects the PDF next to the main
  file).
- Only macOS is packaged. The code has no macOS-only parts in the editor or
  backend, but other platforms are not built or tested by `build.sh`.

## License

Like Overleaf, this code is licensed under the GNU Affero General Public
License v3 (see `LICENSE` in the repository root).
