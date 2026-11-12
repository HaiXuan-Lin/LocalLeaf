// The API that the desktop shell exposes to pages (desktop/preload/preload.js).

export type RecentFolder = { path: string; name: string; exists: boolean };

export type TexStatus = {
  latexmk: string | null;
  synctex: string | null;
  customBinDir: string;
  searched: string[];
};

export type DesktopBridge = {
  openFolderDialog: () => Promise<boolean>;
  openFolder: (folderPath: string) => Promise<boolean>;
  getRecentFolders: () => Promise<RecentFolder[]>;
  removeRecentFolder: (folderPath: string) => Promise<void>;
  revealInFinder: (relPath: string) => Promise<void>;
  openInDefaultApp: (relPath: string) => Promise<void>;
  getTexStatus: () => Promise<TexStatus>;
  chooseTexDirectory: () => Promise<TexStatus>;
  resetTexDirectory: () => Promise<TexStatus>;
  getAppInfo: () => Promise<{
    name: string;
    version: string;
    platform: string;
  }>;
  onCommand: (handler: (command: string, payload?: unknown) => void) => void;
};

export function getBridge(): DesktopBridge | undefined {
  return (window as unknown as { localleafBridge?: DesktopBridge })
    .localleafBridge;
}

export function isMac(): boolean {
  return /Mac/i.test(navigator.platform);
}
