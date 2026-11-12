import { FC, PropsWithChildren } from "react";
import "../../stylesheets/desktop.scss";

/**
 * Wrapped around the editor's context providers (module slot
 * "rootContextProviders"). Its job is to pull the desktop stylesheet into the
 * editor bundle.
 */
const DesktopRootProvider: FC<PropsWithChildren> = ({ children }) => {
  return <>{children}</>;
};

export default DesktopRootProvider;
