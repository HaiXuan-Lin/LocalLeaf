import {
  OLDropdown,
  OLDropdownDivider,
  OLDropdownMenu,
  OLDropdownToggle,
} from "@/shared/components/ol/ol-dropdown-menu";
import MaterialIcon from "@/shared/components/material-icon";
import DropdownMenuItem from "@/shared/components/dropdown/dropdown-menu-item";
import { useProjectContext } from "@/shared/context/project-context";
import { useTranslation } from "react-i18next";
import {
  DownloadProjectPDF,
  DownloadProjectZip,
} from "@/features/ide-react/components/toolbar/download-project";
import { getBridge, isMac } from "../../bridge";

/**
 * Desktop replacement for
 * frontend/js/features/ide-react/components/toolbar/project-title.tsx
 *
 * The "project" is a folder: its name is the folder name. Renaming and
 * copying a folder is Finder's job, so those entries are gone; the folder
 * can be revealed or closed instead.
 */
export const ToolbarProjectTitle = () => {
  const { t } = useTranslation();
  const { name } = useProjectContext();
  const bridge = getBridge();

  return (
    <OLDropdown align="end" className="ide-redesign-toolbar-project-dropdown">
      <OLDropdownToggle
        id="project-title-options"
        aria-label={t("project_title_options")}
        className="ide-redesign-toolbar-project-dropdown-toggle ide-redesign-toolbar-dropdown-toggle-subdued fw-bold ide-redesign-toolbar-button-subdued"
      >
        <span className="ide-redesign-toolbar-project-name" translate="no">
          {name}
        </span>
        <MaterialIcon type="keyboard_arrow_down" />
      </OLDropdownToggle>
      <OLDropdownMenu renderOnMount>
        <DownloadProjectPDF />
        <DownloadProjectZip />
        <OLDropdownDivider />
        <DropdownMenuItem onClick={() => bridge?.openInDefaultApp("")}>
          {isMac() ? "Show folder in Finder" : "Show folder"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => bridge?.openFolderDialog()}>
          Open another folder…
        </DropdownMenuItem>
        <DropdownMenuItem href="/project">Close folder</DropdownMenuItem>
      </OLDropdownMenu>
    </OLDropdown>
  );
};
