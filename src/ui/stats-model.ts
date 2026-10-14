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

/** Serializable statistics page. Charts read these numbers; they do not query SQLite. */
export type StatsPageModel = {
  form: StatsForm;
  repos: string[];
  filtered: boolean;
  empty: boolean;
  cards: StatsCard[];
  trend: { models: string[]; points: StatsTrendPoint[] };
  priorities: StatsBar[];
  types: StatsBar[];
  categories: StatsBar[];
  verdicts: StatsBar[];
  failures: StatsBar[];
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
