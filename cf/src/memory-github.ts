import type {
  GitHub,
  IssueComment,
  PullReview,
  PullReviewComment,
  RemotePull,
  ReviewCommentDraft,
  ReviewEvent,
} from "../../src/github/client.js";
import type { GitHubRepo, ReviewRequest } from "../../src/types.js";
import { FIXTURE_DIFF, FIXTURE_DUREVIEW } from "./fixture.js";

/** In-isolate GitHub. State does not survive eviction, which is what the resume test relies on. */
export class MemoryGitHub implements GitHub {
  comments: IssueComment[] = [];
  reviews: Array<PullReview & { comments: ReviewCommentDraft[]; event: ReviewEvent }> = [];
  reviewComments: PullReviewComment[] = [];
  files = new Map<string, string>();
  fileRefs: string[] = [];
  viewer = "dureview[bot]";
  permissions = new Map<string, string>();
  reactions: Array<{ commentId: number; content: string }> = [];
  remotePull: RemotePull | null = null;
  #next = 1;

  constructor() {
    this.files.set("main\0.dureview.md", FIXTURE_DUREVIEW);
  }

  async getPullDiff(): Promise<string> {
    return FIXTURE_DIFF;
  }

  async listIssueComments(): Promise<IssueComment[]> {
    return this.comments.map((comment) => ({ ...comment }));
  }

  async createIssueComment(_request: ReviewRequest, body: string): Promise<IssueComment> {
    const comment = { id: this.#next++, body };
    this.comments.push(comment);
    return { ...comment };
  }

  async updateIssueComment(_request: ReviewRequest, commentId: number, body: string): Promise<IssueComment> {
    const comment = this.comments.find((item) => item.id === commentId);
    if (!comment) throw new Error(`comment ${commentId} not found`);
    comment.body = body;
    return { ...comment };
  }

  async listReviews(): Promise<PullReview[]> {
    return this.reviews.map((review) => ({ id: review.id, body: review.body }));
  }

  async createReview(
    _request: ReviewRequest,
    review: { sha: string; body: string; event?: ReviewEvent; comments: ReviewCommentDraft[] },
  ): Promise<PullReview> {
    const event = review.event ?? "COMMENT";
    const id = this.#next++;
    this.reviews.push({ id, body: review.body, event, comments: review.comments });
    for (const comment of review.comments) {
      const commentId = this.#next++;
      this.reviewComments.push({
        id: commentId,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        threadId: `PRRT_${commentId}`,
        inReplyToId: null,
        reviewId: id,
        resolved: false,
      });
    }
    return { id, body: review.body };
  }

  async listReviewComments(): Promise<PullReviewComment[]> {
    return this.reviewComments.map((comment) => ({ ...comment }));
  }

  async resolveReviewThread(_request: ReviewRequest, threadId: string): Promise<void> {
    const matched = this.reviewComments.filter((comment) => comment.threadId === threadId);
    if (matched.length === 0) throw new Error(`thread ${threadId} not found`);
    for (const comment of matched) comment.resolved = true;
  }

  async replyToReviewComment(_request: ReviewRequest, commentId: number, body: string): Promise<PullReviewComment> {
    const parent = this.reviewComments.find((comment) => comment.id === commentId);
    if (!parent) throw new Error(`comment ${commentId} not found`);
    const reply: PullReviewComment = {
      id: this.#next++,
      body,
      path: parent.path,
      line: parent.line,
      threadId: parent.threadId,
      inReplyToId: parent.id,
      reviewId: parent.reviewId,
      resolved: parent.resolved,
    };
    this.reviewComments.push(reply);
    return { ...reply };
  }

  async getRepoFile(_request: GitHubRepo, path: string, ref: string): Promise<string | null> {
    this.fileRefs.push(ref);
    return this.files.get(`${ref}\0${path}`) ?? null;
  }

  async viewerLogin(): Promise<string> {
    return this.viewer;
  }

  async collaboratorPermission(_request: GitHubRepo, username: string): Promise<string> {
    return this.permissions.get(username) ?? "none";
  }

  async getPull(): Promise<RemotePull> {
    if (!this.remotePull) throw new Error("pull is not configured");
    return { ...this.remotePull };
  }

  async reactToComment(_request: GitHubRepo, commentId: number): Promise<void> {
    this.reactions.push({ commentId, content: "eyes" });
  }
}
