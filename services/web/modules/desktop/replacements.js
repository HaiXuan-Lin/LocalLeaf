// Front-end modules that are swapped for desktop versions at build time.
//
//   'path below services/web/frontend/js'  ->  'file below ./frontend/js/replacements'
//
// The build fails if a path on the left no longer exists, so a refactor in
// upstream Overleaf is noticed instead of silently re-enabling a feature.
const TOOLBAR = "features/ide-react/components/toolbar";

module.exports = {
  // Sharing, collaborators and history need Overleaf's servers.
  [`${TOOLBAR}/share-project-button`]: "null-component.tsx",
  [`${TOOLBAR}/show-history-button`]: "null-component.tsx",
  [`${TOOLBAR}/online-users`]: "null-component.tsx",
  [`${TOOLBAR}/request-access-button`]: "null-component.tsx",

  // The toolbar speaks about a folder instead of a cloud project.
  [`${TOOLBAR}/logos`]: "toolbar/logos.tsx",
  [`${TOOLBAR}/project-title`]: "toolbar/project-title.tsx",
  [`${TOOLBAR}/menu-bar`]: "toolbar/menu-bar.tsx",

  // One local user with full access and no review features.
  "features/ide-react/context/permissions-context":
    "context/permissions-context.tsx",
};
