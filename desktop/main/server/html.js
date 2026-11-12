"use strict";
const FileTypes = require("../project/FileTypes");
const { MAX_ENTITIES } = require("../project/ProjectTree");

const APP_NAME = require("../../package.json").productName;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Overleaf's frontend reads its configuration from <meta name="ol-..."> tags
 * that the web service renders into the page (see
 * services/web/frontend/js/utils/meta.ts). These helpers render the same
 * tags, with the same conventions as the Pug templates.
 */
function metaString(name, value) {
  if (value == null) return `<meta name="${name}">`;
  return `<meta name="${name}" content="${escapeHtml(value)}">`;
}

function metaJson(name, value) {
  return `<meta name="${name}" data-type="json" content="${escapeHtml(
    JSON.stringify(value === undefined ? null : value),
  )}">`;
}

function metaNumber(name, value) {
  return `<meta name="${name}" data-type="number" content="${escapeHtml(
    JSON.stringify(value),
  )}">`;
}

function metaBoolean(name, value) {
  // true -> empty content attribute, false -> no content attribute
  return value
    ? `<meta name="${name}" data-type="boolean" content>`
    : `<meta name="${name}" data-type="boolean">`;
}

function initialTheme(overallTheme) {
  switch (overallTheme) {
    case "light-":
      return "light";
    case "system":
      return "system";
    default:
      return "dark";
  }
}

function exposedSettings(origin) {
  return {
    isOverleaf: false,
    env: "desktop",
    appName: APP_NAME,
    adminEmail: "",
    dropboxAppName: "",
    ieeeBrandId: 15,
    hasAffiliationsFeature: false,
    hasSamlFeature: false,
    hasLinkUrlFeature: false,
    hasLinkedProjectFileFeature: false,
    hasLinkedProjectOutputFileFeature: false,
    siteUrl: origin,
    emailConfirmationDisabled: true,
    maxEntitiesPerProject: MAX_ENTITIES,
    maxUploadSize: 1024 * 1024 * 1024,
    projectUploadTimeout: 10 * 60 * 1000,
    recaptchaDisabled: {
      invite: true,
      login: true,
      passwordReset: true,
      register: true,
      addEmail: true,
    },
    textExtensions: FileTypes.TEXT_EXTENSIONS,
    editableFilenames: FileTypes.EDITABLE_FILENAMES,
    validRootDocExtensions: FileTypes.ROOT_DOC_EXTENSIONS,
    // only hidden system files are skipped when dropping files into the tree
    fileIgnorePattern: "**/{__MACOSX,.git,.DS_Store}{,/**}",
    sentryAllowedOriginRegex: "",
    enableSubscriptions: false,
    templateLinks: [],
    labsEnabled: false,
    wikiEnabled: false,
    templatesEnabled: false,
    enablePandocConversions: false,
  };
}

/** Tags shared by every page (layout-base.pug). */
function baseMeta({ origin, config, appState, desktop }) {
  const user = appState.user;
  return [
    metaString("ol-csrfToken", "desktop"),
    metaString("ol-baseAssetPath", "/"),
    metaString("ol-mathJaxPath", config.mathJaxPath),
    metaString("ol-dictionariesRoot", config.dictionariesRoot),
    metaString("ol-usersEmail", user.email),
    metaJson("ol-ab", {}),
    metaString("ol-user_id", user.id),
    metaJson("ol-i18n", { currentLangCode: appState.language }),
    metaJson("ol-ExposedSettings", exposedSettings(origin)),
    metaJson("ol-splitTestVariants", config.splitTestVariants || {}),
    metaJson("ol-splitTestInfo", {}),
    metaBoolean("ol-isManagedAccount", false),
    metaJson("ol-desktop", desktop),
  ];
}

function assetTags(manifest, entrypoint) {
  const assets = manifest.entrypoints?.[entrypoint]?.assets || {};
  const css = (assets.css || []).map(
    (href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`,
  );
  const js = (assets.js || []).map(
    (src) =>
      `<script type="text/javascript" src="${escapeHtml(src)}" defer></script>`,
  );
  return { css, js };
}

function mainStylesheet(manifest) {
  const href = manifest["main-style.css"];
  return href
    ? `<link rel="stylesheet" href="${escapeHtml(href)}" id="main-stylesheet">`
    : "";
}

function page({
  lang,
  title,
  head,
  bodyAttributes,
  body,
  scripts,
  theme,
  dataTheme = "light",
}) {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}" class="fixed-size-document">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title translate="no">${escapeHtml(title)}</title>
${head.join("\n")}
</head>
<body class="application-page${bodyAttributes?.className ? " " + bodyAttributes.className : ""}" data-theme="${escapeHtml(dataTheme)}" data-initial-theme="${escapeHtml(theme)}">
${body}
${scripts.join("\n")}
</body>
</html>
`;
}

/**
 * The editor page (app/views/project/ide-react.pug + editor/_meta.pug).
 *
 * @param {object} options
 * @param {import('../project/ProjectSession').ProjectSession} options.session
 * @param {import('../AppState').AppState} options.appState
 * @param {object} options.manifest webpack manifest of the renderer build
 * @param {object} options.config desktop-config.json of the renderer build
 * @param {string} options.origin
 * @param {'' | 'detached'} [options.detachRole]
 */
function renderEditorPage({
  session,
  appState,
  manifest,
  config,
  origin,
  detachRole = "",
}) {
  const user = appState.user;
  const userSettings = appState.getUserSettings();
  const theme = initialTheme(userSettings.overallTheme);
  const entrypoint =
    detachRole === "detached" ? "pages/ide-detached" : "pages/ide";
  const { css, js } = assetTags(manifest, entrypoint);
  const desktop = {
    appName: APP_NAME,
    projectPath: session.rootPath,
    platform: process.platform,
  };

  const head = [
    mainStylesheet(manifest),
    ...css,
    ...baseMeta({ origin, config, appState, desktop }),
    metaString("ol-project_id", session.id),
    metaString("ol-projectName", session.name),
    metaBoolean("ol-canUseClsiCache", false),
    metaBoolean("ol-canUsePng2Pdf", false),
    metaJson("ol-userSettings", userSettings),
    metaJson("ol-user", {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      signUpDate: new Date(0).toISOString(),
      allowedFreeTrial: false,
      hasPaidSubscription: true,
      featureSwitches: [],
      features: session.projectView().features,
      refProviders: {},
      writefull: { autoCreatedAccount: false },
      alphaProgram: false,
      betaProgram: false,
      labsProgram: false,
      inactiveTutorials: appState.getInactiveTutorials(),
      isAdmin: false,
    }),
    metaJson("ol-learnedWords", appState.getLearnedWords()),
    metaBoolean("ol-anonymous", false),
    metaJson("ol-brandVariation", null),
    metaBoolean("ol-isTokenMember", false),
    metaBoolean("ol-isRestrictedTokenMember", false),
    metaBoolean("ol-ownerHasSharingUpdates", false),
    metaNumber("ol-maxDocLength", FileTypes.MAX_DOC_LENGTH),
    metaNumber("ol-maxReconnectGracefullyIntervalMs", 1000),
    metaBoolean("ol-wikiEnabled", false),
    metaJson("ol-capabilities", []),
    metaString("ol-gitBridgePublicBaseUrl", ""),
    metaBoolean("ol-gitBridgeEnabled", false),
    metaString("ol-compilesUserContentDomain", ""),
    // The local backend applies every update itself; no hash check needed.
    metaBoolean("ol-useShareJsHash", false),
    metaString("ol-wsUrl", ""),
    metaJson("ol-wsRetryHandshake", null),
    metaBoolean("ol-debugPdfDetach", false),
    metaBoolean("ol-showSymbolPalette", true),
    metaBoolean("ol-symbolPaletteAvailable", true),
    metaBoolean("ol-showAiFeatures", false),
    metaBoolean("ol-showAiFeaturesDisabled", false),
    metaBoolean("ol-hasUnlimitedAi", false),
    metaBoolean("ol-hasAiFreeTier", false),
    metaString("ol-detachRole", detachRole),
    metaString("ol-defaultLatexCompiler", "pdflatex"),
    metaJson("ol-imageNames", []),
    metaJson("ol-languages", config.languages || []),
    metaJson("ol-editorThemes", config.editorThemes || []),
    metaJson("ol-legacyEditorThemes", config.legacyEditorThemes || []),
    metaBoolean("ol-showUpgradePrompt", false),
    metaBoolean("ol-showSupport", false),
    metaBoolean("ol-showTemplatesServerPro", false),
    metaBoolean("ol-hasTrackChangesFeature", false),
    metaNumber("ol-otMigrationStage", 0),
    metaJson("ol-inactiveTutorials", appState.getInactiveTutorials()),
    metaJson("ol-projectTags", []),
    metaBoolean("ol-ro-mirror-on-client-no-local-storage", false),
    metaBoolean("ol-isSaas", false),
    metaBoolean("ol-shouldLoadHotjar", false),
    metaBoolean("ol-customerIoEnabled", false),
    metaJson("ol-compileSettings", {
      compileTimeout: appState.getCompileSettings().compileTimeout || 600,
    }),
    metaString("ol-loadingText", "Loading"),
    metaString(
      "ol-translationIoNotLoaded",
      "Could not start the editor backend",
    ),
    metaString("ol-translationLoadErrorMessage", "Could not load translations"),
    metaString(
      "ol-translationUnableToJoin",
      "Could not open the project folder",
    ),
    metaJson("ol-overallThemes", [
      { name: "Dark", val: "" },
      { name: "Light", val: "light-" },
      { name: "System", val: "system" },
    ]),
  ];

  const body =
    detachRole === "detached"
      ? '<div id="pdf-preview-detached-root"></div>'
      : `<main id="ide-root">
<div class="loading-screen loading-screen-init-${escapeHtml(theme)}">
<div class="loading-screen-brand-container"><div class="loading-screen-brand" style="height: 20%"></div></div>
<h3 class="loading-screen-label">Loading<span class="loading-screen-ellip">.</span><span class="loading-screen-ellip">.</span><span class="loading-screen-ellip">.</span></h3>
</div>
</main>`;

  return page({
    lang: appState.language,
    title: `${session.name} - ${APP_NAME}`,
    head,
    body,
    bodyAttributes: { className: "desktop-app" },
    // The "socket.io client" is the bridge to the local backend.
    scripts: [
      '<script type="text/javascript" src="/socket.io/socket.io.js" defer></script>',
      ...js,
    ],
    theme,
  });
}

/** The start page: open a folder, recent folders. */
function renderWelcomePage({
  appState,
  manifest,
  config,
  origin,
  prefersDark = false,
}) {
  const userSettings = appState.getUserSettings();
  const theme = initialTheme(userSettings.overallTheme);
  // The page keeps this up to date itself (welcome.tsx); this avoids a flash.
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  const { css, js } = assetTags(manifest, "modules/desktop/pages/welcome");
  const desktop = { appName: APP_NAME, platform: process.platform };
  const head = [
    mainStylesheet(manifest),
    ...css,
    ...baseMeta({ origin, config, appState, desktop }),
    metaJson("ol-userSettings", userSettings),
    metaJson("ol-overallThemes", [
      { name: "Dark", val: "" },
      { name: "Light", val: "light-" },
      { name: "System", val: "system" },
    ]),
  ];
  return page({
    lang: appState.language,
    title: APP_NAME,
    head,
    body: '<main id="desktop-welcome-root"></main>',
    bodyAttributes: { className: "desktop-app desktop-welcome" },
    scripts: js,
    theme,
    dataTheme: dark ? "default" : "light",
  });
}

module.exports = { renderEditorPage, renderWelcomePage, escapeHtml, APP_NAME };
