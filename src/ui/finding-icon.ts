export type FindingIconKind = "bug-severe" | "bug-other" | "flag-investigate" | "flag-info" | "security";

export function findingIconKind(type: string | null, subtype: string | null): FindingIconKind | null {
  if (type === "security") return "security";
  if (type === "bug" && subtype === "severe") return "bug-severe";
  if (type === "bug" && subtype === "non_severe") return "bug-other";
  if (type === "flag" && subtype === "investigate") return "flag-investigate";
  if (type === "flag" && subtype === "informational") return "flag-info";
  return null;
}
