/** Closed mobile sheet: links must leave the tab order and the accessibility tree. */
export function mobileSidebarConcealed(isMobile: boolean, mobileNav: string | undefined): boolean {
  return isMobile && mobileNav !== "open";
}
