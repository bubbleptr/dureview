import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ReviewArchive } from "../src/review/archive.js";
import { fileFacts, postingsForReview, postingsWhenPublishFailed, recordedFindings } from "../src/review/findings.js";
import { defaultPolicy } from "../src/review/policy.js";
import { FIXTURE_DIFF, sampleFinding } from "./support.js";

describe("finding records", () => {
  it("keeps every finding, including ones that are not posted inline", () => {
    const policy = { ...defaultPolicy(), summary: false, maxInline: 1 };
    const inline = sampleFinding({ title: "Dropped charge", priority: 1, confidence: 0.9 });
    const overflow = sampleFinding({ title: "Second bug", priority: 1, confidence: 0.85, startLine: 3, endLine: 3 });
    const investigate = sampleFinding({ title: "Maybe wrong", kind: "investigate", priority: 1, confidence: 0.8 });
    const low = sampleFinding({ title: "Too unsure", priority: 0, confidence: 0.1 });
    const ignored = sampleFinding({ title: "Lockfile", path: "package-lock.json", priority: 1, confidence: 0.95 });
    const outside = sampleFinding({ title: "Other file", path: "src/other.ts", priority: 1, confidence: 0.9 });
    const p3 = sampleFinding({ title: "Nit", priority: 3, confidence: 0.8, startLine: 4, endLine: 4 });
    const already = sampleFinding({ title: "Already", priority: 1 });
    const postings = postingsForReview({
      findings: [inline, overflow, investigate, low, ignored, outside, p3, already],
      diff: FIXTURE_DIFF,
      policy,
      alreadyInlined: new Set([already.fingerprint]),
    });
    const byTitle = new Map(
      recordedFindings([inline, overflow, investigate, low, ignored, outside, p3, already], postings).map((row) => [
        row.finding.title,
        row,
      ]),
    );
    expect(byTitle.get("Dropped charge")).toMatchObject({ posted: true, skipReason: null });
    expect(byTitle.get("Second bug")).toMatchObject({ posted: false, skipReason: "overflow" });
    expect(byTitle.get("Maybe wrong")).toMatchObject({ posted: false, skipReason: "investigate" });
    expect(byTitle.get("Too unsure")).toMatchObject({ posted: false, skipReason: "low_confidence" });
    expect(byTitle.get("Lockfile")).toMatchObject({ posted: false, skipReason: "ignored" });
    expect(byTitle.get("Other file")).toMatchObject({ posted: false, skipReason: "out_of_range" });
    expect(byTitle.get("Nit")).toMatchObject({ posted: false, skipReason: "priority" });
    expect(byTitle.get("Already")).toMatchObject({ posted: false, skipReason: "already_inlined" });
  });

  it("stores informational flags and posts them only when the setting is on", () => {
    const note = sampleFinding({
      title: "Amount check is intentional",
      type: "flag",
      subtype: "informational",
      priority: 0,
      confidence: 0.95,
      trigger: "",
    });
    const held = postingsForReview({ findings: [note], diff: FIXTURE_DIFF, policy: defaultPolicy() });
    expect(recordedFindings([note], held)[0]).toMatchObject({ posted: false, skipReason: "informational" });

    const posted = postingsForReview({
      findings: [note],
      diff: FIXTURE_DIFF,
      policy: { ...defaultPolicy(), postInformational: true },
    });
    expect(recordedFindings([note], posted)[0]).toMatchObject({ posted: true, skipReason: null });
  });

  it("marks summary mentions as posted while keeping the inline skip reason", () => {
    const policy = { ...defaultPolicy(), summary: true };
    const outside = sampleFinding({ title: "Other file", path: "src/other.ts", priority: 1, confidence: 0.9 });
    const postings = postingsForReview({ findings: [outside], diff: FIXTURE_DIFF, policy });
    expect(recordedFindings([outside], postings)[0]).toMatchObject({ posted: true, skipReason: "out_of_range" });
  });

  it("reads extension and language from the path", () => {
    expect(fileFacts("src/pay.ts")).toEqual({ extension: "ts", language: "typescript" });
    expect(fileFacts("web/App.tsx")).toEqual({ extension: "tsx", language: "typescript" });
    expect(fileFacts("Dockerfile")).toEqual({ extension: null, language: null });
    expect(fileFacts(".gitignore")).toEqual({ extension: null, language: null });
  });

  it("does not inherit Object.prototype names as languages", async () => {
    expect(fileFacts("src/pay.constructor")).toEqual({ extension: "constructor", language: null });
    expect(fileFacts("src/pay.valueOf")).toEqual({ extension: "valueof", language: null });

    const dir = await mkdtemp(join(tmpdir(), "dureview-lang-"));
    const file = join(dir, "reviews.sqlite");
    const archive = new ReviewArchive(file);
    await archive.open();
    await archive.finish({
      taskId: "1",
      owner: "acme",
      repo: "demo",
      number: 1,
      outcome: "completed",
      verdict: "fix_recommended",
      findingCount: 1,
      sha: "abc",
      findings: [sampleFinding({ path: "src/pay.constructor", title: "Prototype path" })],
    });
    archive.close();

    const db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT extension, language, title FROM findings").get();
    expect(row).toMatchObject({ extension: "constructor", language: null, title: "Prototype path" });
    db.close();
  });

  it("records a failed publish as not posted", () => {
    const policy = { ...defaultPolicy(), summary: true };
    const inline = sampleFinding({ title: "Dropped charge" });
    const low = sampleFinding({ title: "Too unsure", priority: 0, confidence: 0.1 });
    const postings = postingsWhenPublishFailed(postingsForReview({ findings: [inline, low], diff: FIXTURE_DIFF, policy }));
    const byTitle = new Map(recordedFindings([inline, low], postings).map((row) => [row.finding.title, row]));
    expect(byTitle.get("Dropped charge")).toMatchObject({ posted: false, skipReason: "publish_failed" });
    expect(byTitle.get("Too unsure")).toMatchObject({ posted: false, skipReason: "low_confidence" });
  });
});
