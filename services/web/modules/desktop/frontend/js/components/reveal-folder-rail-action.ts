import type { RailAction } from "@/features/ide-react/components/rail/rail-action-element";
import { getBridge, isMac } from "../bridge";

/**
 * A button at the bottom of the editor's rail (module slot "railActions"):
 * show the project folder in Finder.
 */
const revealFolderAction: RailAction = {
  key: "desktop-reveal-folder",
  icon: "open_in_new",
  title: isMac() ? "Show project folder in Finder" : "Show project folder",
  action: () => {
    getBridge()?.openInDefaultApp("");
  },
  hide: !getBridge(),
};

export default revealFolderAction;
