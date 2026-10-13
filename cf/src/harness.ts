import { PiHarness, type PiHarnessOptions } from "agents/harness/pi";

/**
 * PiHarness wakes a session when `submit()` is used. dureview enqueues a task
 * directly, so schedule the same job or an eviction never resumes the review.
 */
export class ReviewPiHarness extends PiHarness {
  constructor(options: PiHarnessOptions) {
    super(options);
  }

  async wakeSession(session: string, time = Date.now()): Promise<void> {
    await this.lifecycle.ready();
    await this.lifecycle.jobs.push({
      id: `pi-wake:${session}`,
      fn: "wake",
      time,
      payload: { session },
      singleflight: true,
      recoveryLoop: true,
    });
  }
}
