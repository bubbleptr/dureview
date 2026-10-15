import { describe, expect, it } from "vitest";
import { providerAtStart } from "../src/auth/providers.js";
import { confidenceBand, confidenceBars, confidenceWord } from "../src/review/confidence.js";
import { findingIconKind } from "../src/ui/finding-icon.js";

describe("confidence bands", () => {
  it("treats 0.8 and above as high, 0.5 up to 0.8 as medium, and the rest as low", () => {
    expect(confidenceBand(1)).toBe("high");
    expect(confidenceBand(0.8)).toBe("high");
    expect(confidenceBand(0.79)).toBe("medium");
    expect(confidenceBand(0.5)).toBe("medium");
    expect(confidenceBand(0.49)).toBe("low");
    expect(confidenceBars(0.8)).toBe(3);
    expect(confidenceBars(0.5)).toBe(2);
    expect(confidenceBars(0)).toBe(1);
    expect(confidenceWord(0.85, "en")).toBe("high");
    expect(confidenceWord(0.6, "zh")).toBe("中");
    expect(confidenceWord(0.2, "zh")).toBe("低");
  });
});

describe("finding icons", () => {
  it("maps each type and subtype to one mark", () => {
    expect(findingIconKind("bug", "severe")).toBe("bug-severe");
    expect(findingIconKind("bug", "non_severe")).toBe("bug-other");
    expect(findingIconKind("flag", "investigate")).toBe("flag-investigate");
    expect(findingIconKind("flag", "informational")).toBe("flag-info");
    expect(findingIconKind("security", "critical")).toBe("security");
    expect(findingIconKind("security", "warning")).toBe("security");
    expect(findingIconKind(null, null)).toBeNull();
  });
});

describe("provider prefix", () => {
  it("matches the longest provider id at the start of a model line", () => {
    expect(providerAtStart("openai-codex/gpt-5.5 · high")).toBe("openai-codex");
    expect(providerAtStart("openai/gpt-4.1")).toBe("openai");
    expect(providerAtStart("github-copilot/gpt-4o")).toBe("github-copilot");
    expect(providerAtStart("xai/grok-4")).toBe("xai");
    expect(providerAtStart("faux/faux-1")).toBeNull();
  });
});
