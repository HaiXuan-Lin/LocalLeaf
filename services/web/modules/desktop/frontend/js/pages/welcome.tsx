import "@/utils/webpack-public-path";
import "@/i18n";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import OLButton from "@/shared/components/ol/ol-button";
import MaterialIcon from "@/shared/components/material-icon";
import getMeta from "@/utils/meta";
import { getBridge, isMac, RecentFolder, TexStatus } from "../bridge";
import "../../stylesheets/desktop.scss";

function prettyPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function Welcome() {
  const bridge = getBridge();
  const { appName } = getMeta("ol-ExposedSettings");
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const [tex, setTex] = useState<TexStatus | null>(null);
  const [opening, setOpening] = useState(false);

  const refresh = useCallback(() => {
    bridge?.getRecentFolders().then(setRecent);
  }, [bridge]);

  useEffect(() => {
    refresh();
    bridge?.getTexStatus().then(setTex);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [bridge, refresh]);

  const open = useCallback(
    async (action: () => Promise<boolean> | undefined) => {
      setOpening(true);
      try {
        await action();
      } finally {
        setOpening(false);
        refresh();
      }
    },
    [refresh],
  );

  return (
    <div className="desktop-welcome-page">
      <div className="desktop-welcome-card">
        <h1 className="desktop-welcome-title">{appName}</h1>
        <p className="desktop-welcome-tagline">
          Write LaTeX in a folder on this computer. Nothing is uploaded.
        </p>

        <OLButton
          variant="primary"
          size="lg"
          leadingIcon="folder_open"
          disabled={opening}
          onClick={() => open(() => bridge?.openFolderDialog())}
        >
          Open Folder…
        </OLButton>

        {recent.length > 0 && (
          <>
            <h2 className="desktop-welcome-section-title">Recent folders</h2>
            <ul className="desktop-recent-list">
              {recent.map((folder) => (
                <li
                  key={folder.path}
                  className={
                    folder.exists
                      ? "desktop-recent-item"
                      : "desktop-recent-item desktop-recent-missing"
                  }
                >
                  <button
                    className="desktop-recent-open"
                    disabled={opening || !folder.exists}
                    title={
                      folder.exists
                        ? folder.path
                        : "This folder no longer exists"
                    }
                    onClick={() => open(() => bridge?.openFolder(folder.path))}
                  >
                    <MaterialIcon type="folder" />
                    <span className="desktop-recent-text">
                      <span className="desktop-recent-name">{folder.name}</span>
                      <span className="desktop-recent-path">
                        <bdi>{prettyPath(folder.path)}</bdi>
                      </span>
                    </span>
                  </button>
                  <button
                    className="desktop-recent-remove"
                    title="Remove from this list"
                    onClick={() =>
                      bridge?.removeRecentFolder(folder.path).then(refresh)
                    }
                  >
                    <MaterialIcon
                      type="close"
                      accessibilityLabel="Remove from this list"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {tex && (
          <div
            className={
              tex.latexmk
                ? "desktop-tex-status"
                : "desktop-tex-status desktop-tex-status-missing"
            }
          >
            <MaterialIcon type={tex.latexmk ? "check_circle" : "warning"} />
            {tex.latexmk ? (
              <span>
                TeX found: <code>{prettyPath(tex.latexmk)}</code>
              </span>
            ) : (
              <span>
                No TeX distribution found. {appName} compiles with the TeX Live
                or MacTeX installed on this computer.
              </span>
            )}
            <span className="desktop-tex-status-spacer" />
            <OLButton
              variant="secondary"
              size="sm"
              onClick={() => bridge?.chooseTexDirectory().then(setTex)}
            >
              {tex.latexmk ? "Change…" : "Locate…"}
            </OLButton>
          </div>
        )}

        {!bridge && (
          <p className="desktop-tex-status desktop-tex-status-missing">
            This page only works inside the {appName} app
            {isMac() ? "" : " window"}.
          </p>
        )}
      </div>
    </div>
  );
}

const container = document.getElementById("desktop-welcome-root");
if (container) {
  createRoot(container).render(<Welcome />);
}
