import type { StatsForm } from "./stats-query.js";

export type StatsCard = {
  label: string;
  value: string;
  detail: string;
};

export type StatsTrendPoint = {
  day: string;
  label: string;
} & Record<string, string | number | null>;

export type StatsBar = {
  name: string;
  count: number;
  share: string;
};

export type StatsRankRow = {
  label: string;
  href: string;
  reviews: string;
  findings: string;
  tokens: string;
  cost: string;
};

export type AdoptionTrendPoint = {
  day: string;
  label: string;
  adopted: number;
  ignored: number;
  /** 0–100. Pending comments are not in this rate. */
  rate: number;
};

export type RecurringGroup = {
  category: string;
  count: string;
  titles: Array<{ title: string; count: string }>;
};

export type HotspotRow = {
  repo: string;
  directory: string;
  count: string;
};

export type SpeedPoint = {
  id: string;
  label: string;
  detail: string;
  minutes: number;
  duration: string;
};

/** Serializable statistics page. Charts read these numbers; they do not query SQLite. */
export type StatsPageModel = {
  form: StatsForm;
  repos: string[];
  filtered: boolean;
  empty: boolean;
  adoptionCards: StatsCard[];
  adoptionTrend: AdoptionTrendPoint[];
  recurring: RecurringGroup[];
  hotspots: HotspotRow[];
  speedCards: StatsCard[];
  speed: SpeedPoint[];
  medianMinutes: number | null;
  outlier: { headline: string; detail: string } | null;
  trend: { models: string[]; points: StatsTrendPoint[] };
  priorities: StatsBar[];
  types: StatsBar[];
  categories: StatsBar[];
  verdicts: StatsBar[];
  failures: StatsBar[];
  /** Failed reviews in the range. Reason rows are capped, so this is the total, not their sum. */
  failedReviews: number;
  expensive: StatsRankRow[];
  topRepos: StatsRankRow[];
  topPulls: StatsRankRow[];
  usageNote: string;
  /** Sum of known input + output + cache-read tokens. Null when none of the reviews recorded usage. */
  tokenUsage: {
    total: number | null;
    knownReviews: number;
    unknownReviews: number;
  };
};
