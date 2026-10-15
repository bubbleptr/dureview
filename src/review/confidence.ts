export type ConfidenceBand = "high" | "medium" | "low";

/**
 * High is at least 0.8, above the default P2 inline bar of 0.7.
 * Medium is at least 0.5, the default confidence floor. Anything lower is low.
 */
export function confidenceBand(value: number): ConfidenceBand {
  if (value >= 0.8) return "high";
  if (value >= 0.5) return "medium";
  return "low";
}

export function confidenceBars(value: number): 1 | 2 | 3 {
  const band = confidenceBand(value);
  if (band === "high") return 3;
  if (band === "medium") return 2;
  return 1;
}

const BAND_WORD = {
  en: { high: "high", medium: "medium", low: "low" },
  zh: { high: "高", medium: "中", low: "低" },
} as const;

export function confidenceWord(value: number, language: "en" | "zh"): string {
  return BAND_WORD[language][confidenceBand(value)];
}

export function formatConfidence(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
