// Build-time settings for the desktop app's front end.
//
// Loaded through OVERLEAF_CONFIG by webpack.config.desktop.js and merged over
// config/settings.defaults.js. Only the module slots matter here: they decide
// which components the import-overleaf-module macro wires into the editor.
const Path = require("node:path");

const component = (name) =>
  Path.resolve(__dirname, "frontend/js/components", name);

module.exports = {
  appName: "LocalLeaf",
  // No server-side modules: there is no server.
  moduleImportSequence: [],
  overleafModuleImports: {
    // Wrapped around the whole editor: desktop styles and menu commands.
    rootContextProviders: [component("desktop-root-provider.tsx")],
    // Buttons at the bottom of the rail, between Help and Settings.
    railActions: [component("reveal-folder-rail-action.ts")],
    // Settings > Editor: which TeX installation is used.
    settingsModalEditorTabSections: [component("tex-settings-section.tsx")],
  },
};
