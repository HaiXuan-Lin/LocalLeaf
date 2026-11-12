"use strict";
const os = require("node:os");
const Path = require("node:path");
const { JsonStore } = require("./util/JsonStore");

const MAX_RECENT_FOLDERS = 15;

// The editor settings Overleaf stores on the user account
// (services/web/app/src/Features/Project/UserSettingsHelper.mjs).
const DEFAULT_USER_SETTINGS = {
  mode: "none",
  editorTheme: "textmate",
  editorLightTheme: "textmate",
  editorDarkTheme: "overleaf_dark",
  fontSize: 12,
  autoComplete: true,
  autoPairDelimiters: true,
  pdfViewer: "pdfjs",
  syntaxValidation: true,
  previewTabs: false,
  fontFamily: "lucida",
  lineHeight: "normal",
  overallTheme: "system",
  mathPreview: true,
  breadcrumbs: true,
  editorTabs: true,
  nonBlinkingCursor: false,
  referencesSearchMode: "advanced",
  darkModePdf: false,
  floatingMenu: true,
};

const USER_SETTING_KEYS = new Set([
  ...Object.keys(DEFAULT_USER_SETTINGS),
  "spellCheckLanguage",
]);

/**
 * Everything the app remembers between launches. Lives in the app's user
 * data folder (~/Library/Application Support/<App>), never in a project.
 */
class AppState {
  constructor(userDataDir) {
    this.userDataDir = userDataDir;
    this.store = new JsonStore(Path.join(userDataDir, "settings.json"), {
      userSettings: {},
      recentFolders: [],
      learnedWords: [],
      inactiveTutorials: [],
      language: "en",
      texBinDir: "",
      compileTimeout: 0,
      showBuildArtifacts: false,
    });
    this.projects = new JsonStore(Path.join(userDataDir, "projects.json"), {});
  }

  get buildsDir() {
    return Path.join(this.userDataDir, "builds");
  }

  // --------------------------------------------------------------- the user

  get user() {
    let username = "local";
    try {
      username = os.userInfo().username || username;
    } catch {}
    return {
      id: "000000000000000000000001",
      email: `${username}@localhost`,
      first_name: username,
      last_name: "",
    };
  }

  getUserSettings() {
    return { ...DEFAULT_USER_SETTINGS, ...this.store.get("userSettings") };
  }

  updateUserSettings(changes) {
    const next = { ...this.store.get("userSettings") };
    for (const [key, value] of Object.entries(changes || {})) {
      if (USER_SETTING_KEYS.has(key) && value != null) next[key] = value;
    }
    this.store.set("userSettings", next);
  }

  get language() {
    return this.store.get("language") || "en";
  }

  set language(code) {
    this.store.set("language", code);
  }

  getLearnedWords() {
    return [...(this.store.get("learnedWords") || [])];
  }

  learnWord(word) {
    const words = new Set(this.getLearnedWords());
    words.add(word);
    this.store.set("learnedWords", [...words]);
  }

  unlearnWord(word) {
    this.store.set(
      "learnedWords",
      this.getLearnedWords().filter((w) => w !== word),
    );
  }

  getInactiveTutorials() {
    return [...(this.store.get("inactiveTutorials") || [])];
  }

  completeTutorial(key) {
    const tutorials = new Set(this.getInactiveTutorials());
    tutorials.add(key);
    this.store.set("inactiveTutorials", [...tutorials]);
  }

  // ------------------------------------------------------- compile settings

  getCompileSettings() {
    return {
      texBinDir: this.store.get("texBinDir") || "",
      compileTimeout: Number(this.store.get("compileTimeout")) || 0,
    };
  }

  // --------------------------------------------------------- recent folders

  getRecentFolders() {
    return [...(this.store.get("recentFolders") || [])];
  }

  addRecentFolder(folderPath) {
    const recent = this.getRecentFolders().filter((p) => p !== folderPath);
    recent.unshift(folderPath);
    this.store.set("recentFolders", recent.slice(0, MAX_RECENT_FOLDERS));
  }

  removeRecentFolder(folderPath) {
    this.store.set(
      "recentFolders",
      this.getRecentFolders().filter((p) => p !== folderPath),
    );
  }

  clearRecentFolders() {
    this.store.set("recentFolders", []);
  }

  // ------------------------------------------------------- per-project data

  getProjectSettings(projectId) {
    return { ...(this.projects.get(projectId) || {}) };
  }

  updateProjectSettings(projectId, changes) {
    this.projects.set(projectId, {
      ...(this.projects.get(projectId) || {}),
      ...changes,
    });
  }
}

module.exports = { AppState, DEFAULT_USER_SETTINGS };
