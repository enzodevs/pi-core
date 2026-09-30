# TUI presentation

Pi Core stays inside the installed `@earendil-works/pi-tui` renderer. The UX layer adds no runtime dependency, JSX framework, terminal process, model tool/schema, prompt injection, or conversation message. See [manual validation](test-tui.md).

## Shared boundary

`extensions/ui/` is an internal shared module, shipped with the extensions. A separate `packages/` workspace adds distribution/versioning overhead without a second independent consumer today.

- `sections.ts` provides safe display text, wrapping, explicit line windows and composition of pinned header/content/footer regions. Each panel owns the allocation and navigation that its task needs.
- `presentation.ts` retains the compact fallback viewport and focus/lifecycle wrapper used for simple dialogs such as password entry. It is not the general layout solution for complex panels.
- `index.ts` hides the working indicator through `setWorkingIndicator({ frames: [] })`, retaining native progress text without animation. Header and theme remain native; footer design is intentionally unchanged.

These are keyboard-first components. Native Input, Editor, SelectList, Image, key parsing, themes and width utilities are reused. No second renderer owns stdin/stdout. A future mouse-enabled scroll region needs coordinate-aware dispatch rather than forwarding unadjusted positions through a clipped line viewport.

## Task-specific layouts

**Processes:** overview prioritizes recognizable commands, directory, state and recent output. Tab opens scrollable logs and complete wrapped metadata. Logs read a bounded 32 KiB retained tail; scrolling pauses following and End resumes it. This is not unlimited transcript storage. ID, mode and PID remain in details. S opens an in-panel confirmation tied to the specific process ID; only explicit confirmation calls the existing stop function. UI feedback/logs are not delivered to the model.

**Questions:** the prompt is pinned over choice content. Tab opens full question/context/selected-description reading; Escape returns without losing selection. Native Editor handles Other; unfinished text survives going back. Multi-select exposes the count and supports Ctrl+Enter. Reading long content never submits or cancels an answer. Existing tool schemas and result content remain unchanged.

**Accounts:** tabs remain source-qualified and never activate merely through navigation. Active-session/default-new-session states stay distinct. Actions use the native SelectList and retain existing side-effect/confirmation handlers. G moves between semantic groups (use/manage/confirmation); V opens scrollable quota, renewal, origin and consequences. Compact overview reduces repetition, not access to information. No new account lookup or provider request is introduced by browsing.

**Skills:** native Input provides search, with IME focus propagation. The selected mode explains future prompt visibility and inheritance. Persistence is acknowledged after the callback resolves; failure preserves the previous displayed and active setting and permits retry. Pending writes block closing/mode changes until settled. Changes continue to affect model visibility only through existing explicit skill-setting semantics.

**Context:** purpose-driven labels keep the active panel visible. Inventory Enter opens full scrollable details; Escape returns to the same selection. Serialized messages, effective instructions and provider payload retain diagnostic depth. The UI does not add an entry or tool to model context.

**Drafts:** Ctrl+Shift+S parks/restores/swaps text without overwriting either prompt. The indicator names restore or swap according to current editor content. Ctrl+Alt+D opens a read-only scrollable preview without restoring or persisting a new entry. Image-placeholder prompts cannot be parked: clipboard references belong to the live editor, not durable text state.

**Images:** the passive widget remains bounded. Ctrl+Alt+I opens all attachments through native SelectList, asynchronously loading one preview at a time and discarding stale loads. V exposes complete paths; confirmed D removes only the placeholder/attachment, never the original file. Native image escape streams are rendered only when the entire image region fits, not cropped midway. Inline capability remains terminal-dependent.

**Password:** a bounded mask, Ctrl+U, IME cursor and disposal cleanup remain available. Credential handling is unchanged. **Autocomplete:** explicit paths, cancellation and sanitized labels retain native completion behavior. **Recap:** idle terminal interaction postpones an existing recap and never starts an extra request merely from navigation; the observer unsubscribes on shutdown.

## Limits and verification

At extremely small heights not all regions can coexist; explicit reading/detail views preserve access. Width-safe clipping is not proof of human usability. Automated tests cover bounds, wrapped content, rapid navigation before render, selections, cursor/focus, backtracking without loss, confirmations, save failure/retry, read-only inspection, and all packaged extension loading. Real terminal IME/image behavior and appearance require interactive validation in regular and fullscreen modes. No personal settings file is rewritten.

## External alternatives considered

- [Ink](https://github.com/vadimdemedes/ink): React/Flexbox terminal renderer for Node; not a drop-in Pi Component implementation.
- [OpenTUI](https://github.com/anomalyco/opentui): native Zig core with TypeScript bindings and React/Solid reconcilers; documented setup uses Bun.
- [opentui-island](https://github.com/benvinegar/opentui-island): Node-hosted pi-tui/Ink bridge with a Bun sidecar. Published examples use the older `@mariozechner/pi-tui` namespace; compatibility with this repository's `@earendil-works/pi-tui` 0.99.1 has not been tested.

These are research findings, not installed or validated dependencies. Existing primitives avoid the extra runtime/framework/process cost for these panels.
