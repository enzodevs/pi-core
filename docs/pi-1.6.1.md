# Pi 1.6.1 reconciliation

The four Pi development pins advance from 1.6.0 to 1.6.1. The compatible 1.x peers and Node >=22.19.0 requirement are unchanged. No extension runtime patch is required.

- **Transcript notices:** Pi migrates `showCacheMissNotices` to all four `notices` flags. No pi-core extension reads that setting or calls the removed `SettingsManager` accessors. Customize individual notices in `/settings`; no pi-core migration is needed.
- **Provider events:** `after_provider_response` can now fire on HTTP errors and once per retry. No pi-core extension subscribes to it; a future subscriber should not equate one event with one completed turn.
- **Dialogs:** `confirm()` already reports `permission`, the right default for the sudo approval. `blockedKind` is a presentation hint, not an authorization mechanism.
- **Bash:** the session-CWD wrapper composes Pi's output schema and forwards native foreground results, including `full_output_error` when a truncated transcript cannot be saved. The JSON Headroom filter already skips truncated results even without a file path.

## Decision models: available on demand, not an automatic gate

Classification is not new. Pi 1.6.1 adds Copilot's `gpt-6-luna-decisions`, Radius decision models, optional provider `responseId`, and billed rather than estimated cost when reported by OpenRouter System One. The native codemode API is sufficient: `await models.getAvailableOfType("classifier")` lists classifiers available with the session's credentials without running inference. An empty list is a valid outcome. A working chat login does not imply classifier access.

Use `models.classify()` for repeated judgments with explicit labels, not for facts a parser or test can establish. A good first pilot is triage of sanitized issue descriptions: give each item the same rubric (`bug`, `feature`, `docs`, `unclear`) and compare its result to human labels on held-out examples. Measure mistakes, abstentions, latency and cost before automating routing. Group questions about the same item in one call; a batch of different items still makes one request per item. Check `stopReason` before using answers and send uncertain cases to review.

No extra tool, global provider configuration or automatic calls are needed. Authorize provider spending and data transfer before a hosted pilot. Never substitute a classifier score for user approval, a security boundary, or a passing check.
