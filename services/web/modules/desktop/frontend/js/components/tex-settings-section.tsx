import { useCallback, useEffect, useState } from "react";
import OLButton from "@/shared/components/ol/ol-button";
import Setting from "@/features/ide-settings/components/setting";
import type { SettingsSection } from "@/features/ide-settings/context/types";
import { getBridge, TexStatus } from "../bridge";

function prettyPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function TexDistributionSetting() {
  const bridge = getBridge();
  const [status, setStatus] = useState<TexStatus | null>(null);

  useEffect(() => {
    bridge?.getTexStatus().then(setStatus);
  }, [bridge]);

  const choose = useCallback(() => {
    bridge?.chooseTexDirectory().then(setStatus);
  }, [bridge]);

  const reset = useCallback(() => {
    bridge?.resetTexDirectory().then(setStatus);
  }, [bridge]);

  let description = "Looking for latexmk…";
  if (status) {
    description = status.latexmk
      ? `Using ${prettyPath(status.latexmk)}${
          status.customBinDir
            ? " (folder chosen by you)"
            : " (found automatically)"
        }`
      : "latexmk was not found. Install MacTeX or TeX Live, or choose the folder that contains latexmk.";
  }

  return (
    <Setting
      controlId="desktop-tex-distribution"
      label="TeX distribution"
      description={description}
    >
      <div className="desktop-tex-setting-buttons">
        {status?.customBinDir && (
          <OLButton variant="ghost" size="sm" onClick={reset}>
            Detect automatically
          </OLButton>
        )}
        <OLButton
          id="desktop-tex-distribution"
          variant="secondary"
          size="sm"
          onClick={choose}
        >
          Choose folder…
        </OLButton>
      </div>
    </Setting>
  );
}

/**
 * An extra section at the end of Settings > Editor (module slot
 * "settingsModalEditorTabSections"): which TeX installation compiles the
 * documents. Upstream has no slot for the Compiler tab.
 */
export default function useTexSettingsSection(): SettingsSection | null {
  if (!getBridge()) return null;
  return {
    key: "desktop-tex",
    title: "LaTeX on this computer",
    settings: [
      {
        key: "desktop-tex-distribution",
        component: <TexDistributionSetting />,
      },
    ],
  };
}
