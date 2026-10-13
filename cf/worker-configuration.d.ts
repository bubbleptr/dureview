interface Env {
  REVIEW: DurableObjectNamespace;
  DUREVIEW_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_API_URL?: string;
  MODEL_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_ID?: string;
  MODEL_PROVIDER?: string;
  DUREVIEW_THINKING?: string;
  DUREVIEW_DEFAULT_TRIGGER?: string;
  DUREVIEW_SKIP_DRAFTS?: string;
  /** Test-only. Unset in production. */
  DUREVIEW_TEST_HOOKS?: string;
  GITHUB_MODE?: string;
  GIT_CLONE_BASE?: string;
  FIXTURE_SHA?: string;
}
