import OLTooltip from "@/shared/components/ol/ol-tooltip";
import MaterialIcon from "@/shared/components/material-icon";

/**
 * Desktop replacement for
 * frontend/js/features/ide-react/components/toolbar/logos.tsx
 *
 * The home button leads to the app's start page (open folder, recent
 * folders) instead of the Overleaf project dashboard.
 */
export const ToolbarLogos = () => {
  const label = "Close folder and go to the start page";
  return (
    <div className="ide-redesign-toolbar-logos">
      <OLTooltip
        id="tooltip-home-button"
        description={label}
        overlayProps={{ delay: 0, placement: "bottom" }}
      >
        <div className="ide-redesign-toolbar-home-button">
          <a
            href="/project"
            className="ide-redesign-toolbar-home-link desktop-home-link"
            aria-label={label}
          >
            <MaterialIcon type="home" />
          </a>
        </div>
      </OLTooltip>
    </div>
  );
};
