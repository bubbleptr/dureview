import { createContext, useContext, type ReactNode } from "react";
import { safeUiReturn } from "./next-path.js";

const PageLocationContext = createContext("/ui");

export function PageLocationProvider({ location, children }: { location: string; children: ReactNode }) {
  return <PageLocationContext.Provider value={safeUiReturn(location)}>{children}</PageLocationContext.Provider>;
}

export function usePageLocation(): string {
  return useContext(PageLocationContext);
}
