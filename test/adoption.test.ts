import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ReviewArchive } from "../src/review/archive.js";
import {
  classifyFindingAdoption,
  findingThreadResolved,
  linesTouched,
  patchTouchesLines,
  type AdoptionDiffFile,
} from "../src/review/adoption.js";
import { isDurationOutlier } from "../src/review/stats.js";
import { DureviewService } from "../src/service.js";
import {
  BASE_SHA,
  MemoryGitHub,
  openTestService,
  pullPayload,
  reviewRequest,
  scriptedReview,
  SECRET,
  SHA_A,
  SHA_B,
  tempDataDir,
} from "./support.js";

const SPAN = { path: "src/pay.ts", startLine: 20, endLine: 22 };

describe("adoption classifier", () => {
  it("stays pending while the pull request is open", () => {
    expect(
      classifyFindingAdoption({
        pullOpen: true,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: true,
        finding: { path: "src/pay.ts", startLine: 2, endLine: 2 },
        files: [diffFile("src/pay.ts", "modified", deleteLine(2))],
      }),
    ).toBe("pending");
  });

  it("ignores a closed pull request whose lines and thread were left alone", () => {
    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: false,
        finding: SPAN,
        files: [diffFile("src/other.ts", "modified", deleteLine(1))],
      }),
    ).toBe("ignored");
  });

  it("adopts when a later diff edits the finding's lines, including an incidental edit", () => {
    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: false,
        finding: { path: "src/pay.ts", startLine: 2, endLine: 2 },
        files: [diffFile("src/pay.ts", "modified", deleteLine(2))],
      }),
    ).toBe("adopted");
  });

  it("does not treat a line shift above the finding as a change to its lines", () => {
    const shifted = [
      "@@ -1,3 +1,5 @@",
      " line one",
      "+inserted",
      "+inserted",
      " line two",
      " line three",
    ].join("\n");
    expect(patchTouchesLines(shifted, 20, 22)).toBe(false);
    expect(linesTouched(SPAN, [diffFile("src/pay.ts", "modified", shifted)])).toBe("untouched");
    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: false,
        finding: SPAN,
        files: [diffFile("src/pay.ts", "modified", shifted)],
      }),
    ).toBe("ignored");

    const shiftedThenEdited = [
      shifted,
      "@@ -20,3 +22,3 @@",
      " line twenty",
      "-line twenty-one",
      "+line twenty-one fixed",
      " line twenty-two",
    ].join("\n");
    expect(patchTouchesLines(shiftedThenEdited, 20, 22)).toBe(true);
    const replaced = ["@@ -20,2 +20,2 @@", "-line twenty", "+line twenty fixed", " line twenty-one"].join("\n");
    expect(patchTouchesLines(replaced, 21, 21)).toBe(false);
    expect(patchTouchesLines(replaced, 20, 20)).toBe(true);
    const inserted = ["@@ -21,1 +21,2 @@", "+added", " line twenty-one"].join("\n");
    expect(patchTouchesLines(inserted, 21, 21)).toBe(true);
    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: false,
        finding: SPAN,
        files: [diffFile("src/pay.ts", "modified", shiftedThenEdited)],
      }),
    ).toBe("adopted");
  });

  it("adopts a resolved thread only when a later commit exists", () => {
    const posted = { fingerprint: "aaaaaaaaaaaa", taskId: "task_1" };
    expect(findingThreadResolved(posted, [{ body: "<!-- dureview:finding aaaaaaaaaaaa task_1 -->", resolved: true }])).toBe(true);
    expect(findingThreadResolved(posted, [{ body: "<sub>dureview · fp:aaaaaaaaaaaa</sub>", resolved: true, threadId: "T1" }])).toBe(true);
    expect(findingThreadResolved(posted, [{ body: "<!-- dureview:finding aaaaaaaaaaaa task_1 -->", resolved: false }])).toBe(false);
    expect(
      findingThreadResolved(posted, [
        { body: "<!-- dureview:finding aaaaaaaaaaaa task_0 -->", resolved: true, threadId: "old" },
        { body: "<!-- dureview:finding aaaaaaaaaaaa task_1 -->", resolved: false, threadId: "new" },
      ]),
    ).toBe(false);
    expect(
      findingThreadResolved(
        { fingerprint: "aaaaaaaaaaaa", taskId: "task_1" },
        [
          { body: "<!-- dureview:finding aaaaaaaaaaaa task_1 -->", resolved: false, threadId: "new" },
          { body: "fixed", resolved: true, threadId: "new" },
        ],
      ),
    ).toBe(true);
    expect(
      findingThreadResolved(posted, [
        { body: "<sub>dureview · fp:aaaaaaaaaaaa</sub>", resolved: true, threadId: "old" },
        { body: "<sub>dureview · fp:aaaaaaaaaaaa</sub>", resolved: false, threadId: "new" },
      ]),
    ).toBe(false);

    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: true,
        finding: SPAN,
        files: [],
      }),
    ).toBe("adopted");
    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_A,
        threadResolved: true,
        finding: SPAN,
        files: [],
      }),
    ).toBe("ignored");
  });

  it("leaves a finding unclassified when the compare file list is capped and omits its path", () => {
    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: false,
        diffCapped: true,
        finding: SPAN,
        files: [diffFile("src/other.ts", "modified", deleteLine(1))],
      }),
    ).toBe("unclassified");
    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: false,
        diffCapped: true,
        finding: SPAN,
        files: [diffFile("src/pay.ts", "modified", deleteLine(1))],
      }),
    ).toBe("ignored");
  });

  it("does not treat a missing patch as an untouched file", () => {
    expect(linesTouched(SPAN, [diffFile("src/pay.ts", "modified", null)])).toBe("unknown");
    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: false,
        finding: SPAN,
        files: [diffFile("src/pay.ts", "modified", null)],
      }),
    ).toBe("unclassified");
    const renamed: AdoptionDiffFile = {
      filename: "src/billing.ts",
      previousFilename: "src/pay.ts",
      status: "renamed",
      patch: null,
    };
    expect(linesTouched(SPAN, [renamed])).toBe("unknown");
    expect(
      classifyFindingAdoption({
        pullOpen: false,
        reviewSha: SHA_A,
        finalHeadSha: SHA_B,
        threadResolved: true,
        finding: SPAN,
        files: [diffFile("src/pay.ts", "modified", null)],
      }),
    ).toBe("adopted");
  });

  it("treats a deleted file and a rename that edits the old path as adopted", () => {
    expect(linesTouched(SPAN, [diffFile("src/pay.ts", "removed", null)])).toBe("touched");
    const renamed: AdoptionDiffFile = {
      filename: "src/billing.ts",
      previousFilename: "src/pay.ts",
      status: "renamed",
      patch: deleteLine(21),
    };
    expect(linesTouched(SPAN, [renamed])).toBe("touched");
  });
});

describe("duration outliers", () => {
  it("flags a long run that is also far above the median", () => {
    expect(isDurationOutlier(28 * 60 * 1000, 20_000)).toBe(true);
    expect(isDurationOutlier(20_000, 20_000)).toBe(false);
    expect(isDurationOutlier(28 * 60 * 1000, 28 * 60 * 1000)).toBe(false);
    expect(isDurationOutlier(28 * 60 * 1000, null)).toBe(false);
  });
});

describe("adoption migration", () => {
  it("adds adoption columns without inventing an outcome for existing findings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-adoption-"));
    const file = join(dir, "reviews.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE findings (
        id INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        sha TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        priority INTEGER NOT NULL,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        confidence REAL NOT NULL,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        extension TEXT,
        language TEXT,
        fingerprint TEXT NOT NULL,
        posted INTEGER,
        skip_reason TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    db.prepare(
      `INSERT INTO findings (
        task_id, owner, repo, number, sha, title, body, trigger_text, priority, kind, category, confidence,
        path, start_line, end_line, fingerprint, posted, skip_reason, created_at
      ) VALUES ('old', 'acme', 'demo', 1, ?, 'Legacy', 'body', 'trigger', 1, 'bug', 'correctness', 0.9, 'src/pay.ts', 2, 2, 'aaaaaaaaaaaa', 1, NULL, '2026-01-01T00:00:00.000Z')`,
    ).run(SHA_A);
    db.close();

    const archive = new ReviewArchive(file);
    await archive.open();
    archive.close();

    const check = new DatabaseSync(file, { readOnly: true });
    const names = check.prepare("PRAGMA table_info(findings)").all().map((row) => String(row.name));
    expect(names).toEqual(expect.arrayContaining(["adoption", "adoption_head", "adoption_at"]));
    expect(check.prepare("SELECT adoption, adoption_head, adoption_at FROM findings WHERE task_id = 'old'").get()).toEqual({
      adoption: null,
      adoption_head: null,
      adoption_at: null,
    });
    check.close();
  });
});

describe("adoption webhook", () => {
  it("classifies posted inline comments once and leaves the rest pending", async () => {
    const dataDir = await tempDataDir();
    const file = join(dataDir, "reviews.sqlite");
    const archive = new ReviewArchive(file);
    await archive.open();
    archive.close();
    const db = new DatabaseSync(file);
    insertReview(db, "touch", SHA_A, "2026-10-10T00:00:00.000Z", "2026-10-10T00:00:20.000Z");
    insertReview(db, "short", SHA_A, "2026-10-10T01:00:00.000Z", "2026-10-10T01:00:10.000Z");
    insertReview(db, "shift", SHA_A, "2026-10-11T00:00:00.000Z", "2026-10-11T00:28:00.000Z");
    insertFinding(db, "touch", SHA_A, "aaaaaaaaaaaa", "src/pay.ts", 2, 2, 1, null);
    insertFinding(db, "touch", SHA_A, "bbbbbbbbbbbb", "src/pay.ts", 20, 22, 1, null);
    insertFinding(db, "touch", SHA_A, "cccccccccccc", "src/note.ts", 4, 4, 0, "priority");
    insertFinding(db, "touch", SHA_A, "dddddddddddd", "src/note.ts", 5, 5, 1, "overflow");
    insertFinding(db, "shift", SHA_A, "eeeeeeeeeeee", "src/pay.ts", 20, 22, 1, null);
    db.close();

    const github = new MemoryGitHub();
    github.compared = [diffFile("src/pay.ts", "modified", deleteLine(2))];
    github.reviewComments = [
      {
        id: 1,
        body: "<!-- dureview:finding bbbbbbbbbbbb touch -->",
        path: "src/pay.ts",
        line: 21,
        threadId: "T1",
        inReplyToId: null,
        reviewId: 1,
        resolved: true,
      },
    ];
    const { service } = await openTestService({ dataDir, github, responses: [] });
    const first = await deliver(service, closedPayload(SHA_B));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, classified: 3, merged: true });
    expect(github.compareSpans).toEqual([{ base: SHA_A, head: SHA_B, kind: "since-review" }]);

    const second = await deliver(service, closedPayload(SHA_B));
    expect(second.body).toMatchObject({ ok: true, classified: 0 });
    expect(github.compareSpans).toHaveLength(1);
    await service.close();

    const check = new DatabaseSync(file, { readOnly: true });
    const rows = check.prepare("SELECT fingerprint, adoption, adoption_head FROM findings ORDER BY fingerprint").all() as Array<{
      fingerprint: string;
      adoption: string | null;
      adoption_head: string | null;
    }>;
    expect(rows).toEqual([
      { fingerprint: "aaaaaaaaaaaa", adoption: "adopted", adoption_head: SHA_B },
      { fingerprint: "bbbbbbbbbbbb", adoption: "adopted", adoption_head: SHA_B },
      { fingerprint: "cccccccccccc", adoption: null, adoption_head: null },
      { fingerprint: "dddddddddddd", adoption: null, adoption_head: null },
      { fingerprint: "eeeeeeeeeeee", adoption: "ignored", adoption_head: SHA_B },
    ]);
    check.close();

    const again = new ReviewArchive(file);
    await again.open();
    const changed = await again.recordAdoption([{ id: 1, adoption: "ignored", head: SHA_A }]);
    expect(changed).toBe(0);
    const stats = await again.stats({ repo: "", since: null, tzOffsetMinutes: 0 });
    expect(stats.adoption).toEqual({ adopted: 2, ignored: 1, pending: 0 });
    expect(stats.durations.find((row) => row.taskId === "shift")?.outlier).toBe(true);
    expect(stats.durations.find((row) => row.taskId === "touch")?.outlier).toBe(false);
    expect(stats.hotspots).toEqual(expect.arrayContaining([expect.objectContaining({ repo: "acme/demo", directory: "src" })]));
    const recurring = stats.recurring.find((group) => group.category === "correctness");
    expect(recurring?.count).toBe(5);
    again.close();
  });

  it("leaves findings unclassified when the compare fails, then records them on retry", async () => {
    const dataDir = await tempDataDir();
    const file = join(dataDir, "reviews.sqlite");
    const archive = new ReviewArchive(file);
    await archive.open();
    archive.close();
    const db = new DatabaseSync(file);
    insertReview(db, "retry", SHA_A, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:10.000Z");
    insertFinding(db, "retry", SHA_A, "aaaaaaaaaaaa", "src/pay.ts", 2, 2, 1, null);
    db.close();

    const github = new MemoryGitHub();
    github.compareError = new Error("GitHub compare failed (502)");
    const { service } = await openTestService({ dataDir, github, responses: [] });
    const failed = await deliver(service, closedPayload(SHA_B, false));
    expect(failed.status).toBe(500);
    github.compareError = null;
    github.compared = [diffFile("src/pay.ts", "modified", deleteLine(2))];
    const retried = await deliver(service, closedPayload(SHA_B, false));
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ ok: true, classified: 1, merged: false });
    await service.close();

    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare("SELECT adoption FROM findings").get()).toEqual({ adoption: "adopted" });
    check.close();
  });

  it("leaves a large file unclassified when GitHub omits the patch", async () => {
    const dataDir = await tempDataDir();
    const file = join(dataDir, "reviews.sqlite");
    const archive = new ReviewArchive(file);
    await archive.open();
    archive.close();
    const db = new DatabaseSync(file);
    insertReview(db, "wide", SHA_A, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:10.000Z");
    insertFinding(db, "wide", SHA_A, "aaaaaaaaaaaa", "src/pay.ts", 2, 2, 1, null);
    db.close();

    const github = new MemoryGitHub();
    github.compared = [diffFile("src/pay.ts", "modified", null)];
    const { service } = await openTestService({ dataDir, github, responses: [] });
    const closed = await deliver(service, closedPayload(SHA_B));
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ ok: true, classified: 0 });
    await service.close();

    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare("SELECT adoption FROM findings").get()).toEqual({ adoption: null });
    check.close();
  });

  it("leaves findings unset when the compare is not relative to the reviewed head", async () => {
    const dataDir = await tempDataDir();
    const file = join(dataDir, "reviews.sqlite");
    const archive = new ReviewArchive(file);
    await archive.open();
    archive.close();
    const db = new DatabaseSync(file);
    insertReview(db, "diverged", SHA_A, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:10.000Z");
    insertFinding(db, "diverged", SHA_A, "aaaaaaaaaaaa", "src/pay.ts", 2, 2, 1, null);
    db.close();

    const github = new MemoryGitHub();
    github.compareDiverged = true;
    github.compared = [diffFile("src/pay.ts", "modified", deleteLine(2))];
    const { service } = await openTestService({ dataDir, github, responses: [] });
    const closed = await deliver(service, closedPayload(SHA_B));
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ ok: true, classified: 0 });
    await service.close();

    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare("SELECT adoption FROM findings").get()).toEqual({ adoption: null });
    check.close();
  });

  it("leaves findings unset when the compare list is capped and omits their file", async () => {
    const dataDir = await tempDataDir();
    const file = join(dataDir, "reviews.sqlite");
    const archive = new ReviewArchive(file);
    await archive.open();
    archive.close();
    const db = new DatabaseSync(file);
    insertReview(db, "capped", SHA_A, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:10.000Z");
    insertFinding(db, "capped", SHA_A, "aaaaaaaaaaaa", "src/pay.ts", 2, 2, 1, null);
    db.close();

    const github = new MemoryGitHub();
    github.compareCapped = true;
    github.compared = [diffFile("src/other.ts", "modified", deleteLine(1))];
    const { service } = await openTestService({ dataDir, github, responses: [] });
    const closed = await deliver(service, closedPayload(SHA_B));
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ ok: true, classified: 0 });
    await service.close();

    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare("SELECT adoption FROM findings").get()).toEqual({ adoption: null });
    check.close();
  });

  it("leaves findings unset when the thread lookup fails, then records them once it succeeds", async () => {
    const dataDir = await tempDataDir();
    const file = join(dataDir, "reviews.sqlite");
    const archive = new ReviewArchive(file);
    await archive.open();
    archive.close();
    const db = new DatabaseSync(file);
    insertReview(db, "threads", SHA_A, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:10.000Z");
    insertFinding(db, "threads", SHA_A, "aaaaaaaaaaaa", "src/pay.ts", 20, 22, 1, null);
    db.close();

    const github = new MemoryGitHub();
    github.threadError = new Error("GitHub GraphQL response had no data.");
    github.reviewComments = [
      {
        id: 1,
        body: "<!-- dureview:finding aaaaaaaaaaaa threads -->",
        path: "src/pay.ts",
        line: 21,
        threadId: "T1",
        inReplyToId: null,
        reviewId: 1,
        resolved: true,
      },
    ];
    const { service } = await openTestService({ dataDir, github, responses: [] });
    const failed = await deliver(service, closedPayload(SHA_B));
    expect(failed.status).toBe(500);
    github.threadError = null;
    const retried = await deliver(service, closedPayload(SHA_B));
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ ok: true, classified: 1 });
    await service.close();

    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare("SELECT adoption FROM findings").get()).toEqual({ adoption: "adopted" });
    check.close();
  });

  it("classifies a comment that is archived after the pull request already closed", async () => {
    const dataDir = await tempDataDir();
    const github = new MemoryGitHub();
    github.compared = [diffFile("src/pay.ts", "modified", deleteLine(2))];
    const { service } = await openTestService({
      dataDir,
      github,
      responses: scriptedReview("charge() reports success without billing."),
    });
    const closed = await deliver(service, closedPayload(SHA_B));
    expect(closed.body).toMatchObject({ ok: true, classified: 0, merged: true });

    const queued = await service.enqueue(reviewRequest(SHA_A), { kind: "sha" }, "opened");
    const settled = await service.wait(queued.taskId);
    expect(settled.state.outcome.status).toBe("completed");
    await service.close();

    const check = new DatabaseSync(join(dataDir, "reviews.sqlite"), { readOnly: true });
    expect(check.prepare("SELECT posted, adoption, adoption_head FROM findings").get()).toEqual({
      posted: 1,
      adoption: "adopted",
      adoption_head: SHA_B,
    });
    check.close();
  });

  it("does not classify a review archived after the pull request was reopened", async () => {
    const dataDir = await tempDataDir();
    const github = new MemoryGitHub();
    github.compared = [diffFile("src/pay.ts", "modified", deleteLine(2))];
    const { service } = await openTestService({
      dataDir,
      github,
      responses: scriptedReview("charge() reports success without billing."),
    });
    expect((await deliver(service, closedPayload(SHA_B))).body).toMatchObject({ classified: 0 });
    expect((await deliver(service, pullPayload(SHA_B, "reopened"))).status).toBe(200);
    const queued = await service.enqueue(reviewRequest(SHA_A), { kind: "sha" }, "opened");
    expect((await service.wait(queued.taskId)).state.outcome.status).toBe("completed");
    await service.close();

    const check = new DatabaseSync(join(dataDir, "reviews.sqlite"), { readOnly: true });
    expect(check.prepare("SELECT posted, adoption FROM findings").get()).toEqual({ posted: 1, adoption: null });
    check.close();
  });
});

function diffFile(filename: string, status: string, patch: string | null): AdoptionDiffFile {
  return { filename, previousFilename: null, status, patch };
}

function deleteLine(line: number): string {
  return [`@@ -${line},1 +${line},1 @@`, `-old ${line}`, `+new ${line}`].join("\n");
}

function closedPayload(sha: string, merged = true): Record<string, unknown> {
  const payload = pullPayload(sha, "closed");
  (payload.pull_request as { merged: boolean }).merged = merged;
  return payload;
}

function deliver(service: DureviewService, payload: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  return service.handleWebhook(raw, signature, "pull_request");
}

function insertReview(db: DatabaseSync, taskId: string, sha: string, startedAt: string, finishedAt: string): void {
  db.prepare(
    `INSERT INTO reviews (
      task_id, owner, repo, number, title, sha, base_sha, base_ref, trigger, started_at, finished_at, outcome, verdict
    ) VALUES (?, 'acme', 'demo', 7, 'Charge', ?, ?, 'main', 'opened', ?, ?, 'completed', 'fix_recommended')`,
  ).run(taskId, sha, BASE_SHA, startedAt, finishedAt);
}

function insertFinding(
  db: DatabaseSync,
  taskId: string,
  sha: string,
  fingerprint: string,
  path: string,
  start: number,
  end: number,
  posted: number,
  skip: string | null,
): void {
  db.prepare(
    `INSERT INTO findings (
      task_id, owner, repo, number, sha, title, body, trigger_text, priority, kind, category, confidence,
      path, start_line, end_line, fingerprint, posted, skip_reason, created_at
    ) VALUES (?, 'acme', 'demo', 7, ?, ?, 'body', 'trigger', 1, 'bug', 'correctness', 0.9, ?, ?, ?, ?, ?, ?, '2026-10-10T00:00:00.000Z')`,
  ).run(taskId, sha, fingerprint, path, start, end, fingerprint, posted, skip);
}
