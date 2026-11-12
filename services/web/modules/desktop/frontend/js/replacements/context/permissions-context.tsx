import { createContext, FC, PropsWithChildren, useContext } from "react";
import type { Permissions } from "@/features/ide-react/types/permissions";

/**
 * Desktop replacement for
 * frontend/js/features/ide-react/context/permissions-context.tsx
 *
 * There is exactly one user, working on their own folder: full read/write
 * access, and none of the review features (comments, labelled versions) that
 * need Overleaf's servers.
 */
const localPermissions: Permissions = {
  read: true,
  write: true,
  // "may edit, tracked or not": the editing commands are gated on this
  trackedWrite: true,
  admin: true,
  comment: false,
  resolveOwnComments: false,
  resolveAllComments: false,
  labelVersion: false,
};

export const PermissionsContext = createContext<Permissions | undefined>(
  undefined,
);

export const PermissionsProvider: FC<PropsWithChildren> = ({ children }) => {
  return (
    <PermissionsContext.Provider value={localPermissions}>
      {children}
    </PermissionsContext.Provider>
  );
};

export function usePermissionsContext() {
  const context = useContext(PermissionsContext);

  if (!context) {
    throw new Error(
      "usePermissionsContext is only available inside PermissionsProvider",
    );
  }

  return context;
}
