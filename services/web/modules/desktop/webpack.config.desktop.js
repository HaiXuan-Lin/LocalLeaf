// Webpack build of the editor front end for the offline desktop app
// (see /desktop/README.md).
//
// It reuses Overleaf's own frontend build (../../webpack.config.js) with
// three differences:
//  - only the editor pages are built, plus the desktop start page;
//  - a short list of modules is swapped for desktop versions
//    (see ./frontend/js/replacements);
//  - the result goes to /desktop/build/app/renderer instead of public/.
//
// Run through the build script:  ./build.sh   (or desktop/scripts/build-renderer.sh)
const fs = require("node:fs");
const path = require("node:path");

const WEB_DIR = path.resolve(__dirname, "../..");
const REPO_DIR = path.resolve(WEB_DIR, "../..");
const MODULE_DIR = __dirname;

// Module slots (overleafModuleImports) are read from the settings at build
// time by the import-overleaf-module macro.
process.env.OVERLEAF_CONFIG = path.join(MODULE_DIR, "settings.desktop.js");

const webpack = require("webpack");
const CopyPlugin = require("copy-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");
const CssMinimizerPlugin = require("css-minimizer-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const Settings = require("@overleaf/settings");
const PackageVersions = require("../../app/src/infrastructure/PackageVersions");
const base = require("../../webpack.config.js");

const OUTPUT_DIR =
  process.env.LOCALLEAF_RENDERER_OUT ||
  path.join(REPO_DIR, "desktop/build/app/renderer");
const isDev = process.env.LOCALLEAF_DEV === "1";

// ------------------------------------------------------- spelling dictionaries
//
// All of Overleaf's Hunspell dictionaries together weigh ~270 MB. English is
// bundled by default; choose others with LOCALLEAF_DICTIONARIES, e.g.
//   LOCALLEAF_DICTIONARIES=en_US,en_GB,de_DE,fr ./build.sh
//   LOCALLEAF_DICTIONARIES=all ./build.sh
const DEFAULT_DICTIONARIES = "en_US,en_GB,en_CA,en_AU";
const requestedDictionaries = (
  process.env.LOCALLEAF_DICTIONARIES || DEFAULT_DICTIONARIES
)
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const allDictionaries = requestedDictionaries.includes("all");
const spellCheckLanguages = Settings.languages.filter(
  (language) =>
    language.dic &&
    (allDictionaries ||
      requestedDictionaries.includes(language.dic) ||
      requestedDictionaries.includes(language.code)),
);
const dictionaryNames = new Set(
  spellCheckLanguages.map((language) => language.dic),
);

// ------------------------------------------------------------------ copy rules
//
// Take Overleaf's CopyPlugin rules, minus what the desktop app does not use.
const baseCopyPlugin = base.plugins.find(
  (plugin) => plugin instanceof CopyPlugin,
);
const copyPatterns = baseCopyPlugin.patterns
  .filter((pattern) => {
    const to = String(pattern.to || "");
    if (to.startsWith("js/libs/pyodide")) return false; // Python runner
    if (to.startsWith("js/libs/highlight.js")) return false; // marketing pages
    // MathJax's speech engine: the editor turns speech off.
    if (String(pattern.from).startsWith("sre/")) return false;
    return true;
  })
  .map((pattern) => {
    if (String(pattern.to || "").startsWith("js/dictionaries/")) {
      return {
        ...pattern,
        filter: (resourcePath) =>
          dictionaryNames.has(
            path.basename(resourcePath).replace(/\.[^.]+$/, ""),
          ),
      };
    }
    return pattern;
  });

// ------------------------------------------------- data for the main process
//
// The Electron main process renders the page and needs a few values that
// Overleaf's web service takes from its settings and controllers.
function readThemeList(name) {
  // Not exported by the controller, so read the literal from its source.
  const source = fs.readFileSync(
    path.join(WEB_DIR, "app/src/Features/Project/ProjectController.mjs"),
    "utf8",
  );
  const match = source.match(
    new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n\\])`),
  );
  if (!match) return [];
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return ${match[1]}`)();
  } catch {
    return [];
  }
}

const translatedLanguages = fs
  .readdirSync(path.join(WEB_DIR, "locales"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""));

const desktopConfig = {
  mathJaxPath: `/js/libs/mathjax-${PackageVersions.version.mathjax}/tex-svg.js`,
  dictionariesRoot: `/js/dictionaries/${PackageVersions.version.dictionaries}/`,
  languages: spellCheckLanguages.map(({ code, dic, name }) => ({
    code,
    dic,
    name,
  })),
  editorThemes: readThemeList("THEME_LIST"),
  legacyEditorThemes: readThemeList("LEGACY_THEME_LIST"),
  translatedLanguages,
  // Feature flags ("split tests") of the editor to switch on.
  splitTestVariants: {
    // count words in the browser instead of asking the compile server
    "word-count-client": "enabled",
  },
};

class EmitDesktopConfigPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap(
      "EmitDesktopConfigPlugin",
      (compilation) => {
        compilation.hooks.processAssets.tap(
          {
            name: "EmitDesktopConfigPlugin",
            stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
          },
          () => {
            compilation.emitAsset(
              "desktop-config.json",
              new webpack.sources.RawSource(
                JSON.stringify(desktopConfig, null, 2),
              ),
            );
          },
        );
      },
    );
  }
}

// ------------------------------------------------------- module replacements
//
// Front-end modules that only make sense with Overleaf's servers behind them
// are replaced by desktop versions. Keys are paths below frontend/js (without
// extension), values are files below ./frontend/js/replacements.
const REPLACEMENTS = require("./replacements");
const FRONTEND_JS_DIR = path.join(WEB_DIR, "frontend/js");
const SOURCE_EXTENSIONS = [".tsx", ".ts", ".js", ".jsx"];

// absolute path of the original, without extension -> absolute replacement
const replacementsByOriginal = new Map();
for (const [original, replacement] of Object.entries(REPLACEMENTS)) {
  const originalPath = path.join(FRONTEND_JS_DIR, original);
  const replacementPath = path.join(
    MODULE_DIR,
    "frontend/js/replacements",
    replacement,
  );
  if (!fs.existsSync(replacementPath)) {
    throw new Error(`desktop replacement not found: ${replacementPath}`);
  }
  if (!SOURCE_EXTENSIONS.some((ext) => fs.existsSync(originalPath + ext))) {
    throw new Error(
      `desktop replacement target not found: frontend/js/${original} (did upstream move it?)`,
    );
  }
  replacementsByOriginal.set(originalPath, replacementPath);
}

// Rewrites the import before it is resolved, whichever way it is written:
// "./share-project-button", "../toolbar/share-project-button" or
// "@/features/ide-react/components/toolbar/share-project-button".
const replacementPlugin = new webpack.NormalModuleReplacementPlugin(
  /^(\.{1,2}\/|@\/)/,
  (resource) => {
    const request = resource.request;
    let target;
    if (request.startsWith("@/")) {
      target = path.join(FRONTEND_JS_DIR, request.slice(2));
    } else if (resource.context) {
      target = path.resolve(resource.context, request);
    } else {
      return;
    }
    const withoutExtension = target.replace(/\.(tsx?|jsx?)$/, "");
    const replacementPath = replacementsByOriginal.get(withoutExtension);
    // A replacement may import the module it replaces, to wrap it.
    if (replacementPath && resource.contextInfo?.issuer !== replacementPath) {
      resource.request = replacementPath;
    }
  },
);

// ----------------------------------------------------------------- the config

module.exports = {
  ...base,
  mode: isDev ? "development" : "production",
  // Same as Overleaf's production build. The style loaders need source maps
  // to be on; the .map files themselves are left out of the app when it is
  // staged (desktop/scripts/stage-app.js).
  devtool: isDev ? "cheap-module-source-map" : "hidden-source-map",
  context: WEB_DIR,

  entry: {
    "pages/ide": "./frontend/js/pages/ide.tsx",
    "pages/ide-detached": "./frontend/js/ide-detached.ts",
    "modules/desktop/pages/welcome":
      "./modules/desktop/frontend/js/pages/welcome.tsx",
    "main-style": "./frontend/stylesheets/main-style.scss",
  },

  output: {
    ...base.output,
    path: OUTPUT_DIR,
    clean: true,
  },

  cache: {
    type: "filesystem",
    cacheDirectory: path.join(WEB_DIR, ".cache/webpack-desktop"),
    name: isDev ? "development" : "production",
    buildDependencies: {
      config: [
        __filename,
        path.join(MODULE_DIR, "settings.desktop.js"),
        path.join(MODULE_DIR, "replacements.js"),
      ],
    },
  },

  optimization: {
    ...base.optimization,
    minimize: !isDev,
    minimizer: [
      new TerserPlugin({
        parallel: true,
        extractComments: false,
        terserOptions: { format: { comments: false } },
      }),
      new CssMinimizerPlugin(),
    ],
  },

  plugins: [
    ...base.plugins.filter((plugin) => !(plugin instanceof CopyPlugin)),
    new MiniCssExtractPlugin({
      filename: "stylesheets/[name]-[contenthash].css",
    }),
    new CopyPlugin({ patterns: copyPatterns }),
    new EmitDesktopConfigPlugin(),
    replacementPlugin,
  ],

  performance: { hints: false },
  stats: "errors-warnings",
};
