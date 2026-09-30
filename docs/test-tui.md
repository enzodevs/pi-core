# Manual TUI validation

These steps validate the visible experience, complementing the automated width/height, focus, keyboard, persistence, and extension-loader tests. Use a disposable Pi session for questions/processes. Inspecting UI must not create chat entries; explicitly asking the agent to run a tool is an ordinary conversation turn.

## 1. Reload and resize

1. Run `/reload`. If your selected theme was Interstellar, choose another in `/settings`.
2. Confirm the footer remains, the native header/theme are in control, and the animated working indicator is hidden (working text is retained).
3. Test the panels below at roughly 100×30, 60×18 and 35×10 terminal cells, resizing while each is open.
4. Check readable selection, cursor location, useful keyboard hints and a way to reach full content. Very small heights cannot display every region simultaneously.

## 2. Drafts — no agent turn needed

1. Write `Draft A` without submitting. Press Ctrl+Shift+S. The editor clears and a parked-draft indicator appears.
2. Write `Draft B`. The indicator should offer **swap**.
3. Press Ctrl+Alt+D. Read Draft A; scroll if it is multiline. Escape closes; Draft B must still be in the editor.
4. Press Ctrl+Shift+S: editor becomes A, parked draft becomes B. Repeat: editor becomes B, parked draft becomes A.
5. Empty the editor and press Ctrl+Shift+S: A is restored and the parked indicator disappears.
6. Repeat after navigating a session branch; only that branch's persisted draft should be restored.

## 3. Autocomplete

1. Type `@extensions/` and an actual filename prefix. Use the usual Pi autocomplete keys to choose it.
2. Try a file whose path contains spaces; completion must quote the path correctly.
3. Escape from autocomplete; ordinary editor shortcuts must still work. Do not submit unless you want to mention that file to the agent.

## 4. Images — no submission needed

1. Paste the path of a local supported image (PNG/JPEG/GIF/WebP) into the editor. It should become `[Image NN]`.
2. Repeat with three images. The widget shows a bounded preview and Ctrl+Alt+I to inspect all.
3. Press Ctrl+Alt+I; use arrows to inspect every image, including the third. Native inline rendering depends on your terminal; text fallback is valid.
4. Press V to read the full path. Scroll a long path; V or Escape returns to image selection.
5. Press D then Escape: nothing is detached.
6. Press D then Enter: only the selected placeholder/attachment is removed. Its original file must remain on disk; the widget updates.
7. Escape closes. The unsent prompt and other attachments remain intact. Ctrl+Shift+S must refuse an attached-image prompt rather than orphaning its references.

## 5. Skills

1. Open `/skill-manager`. Search with `/`; Enter returns to navigation, Escape clears search.
2. Select a skill. Check the explanation of full/name/searchable/off and whether the mode is explicit or inherited from project/global/default.
3. Tab switches scope. Searching/browsing alone must not change settings.
4. On a disposable skill override, press Right. The panel shows Saving and then Saved only after persistence succeeds.
5. Restore the original setting (or inherit) before closing. Do not induce write errors by changing permissions on real state files; failure/retry is covered by automated tests.

## 6. Questions — ordinary agent turn required

Ask: “Use ask_user_question to ask me a single-choice question with three alternatives, descriptions and a long explanatory context. Do not take any follow-up action based on my answer.”

1. Navigate alternatives: the question stays above the selection.
2. Tab opens full question/context and the selected description. Test Page Up/Down and Home/End; Escape returns to answers, not cancellation.
3. Select Other, type an unfinished answer, press Escape, then reopen Other. The text must remain.
4. Submit or cancel from the main answers view.
5. Repeat with multiSelect enabled: Space toggles choices, selected count stays visible, Ctrl+Enter submits. Submitting zero choices gives guidance rather than an empty answer.

## 7. Processes — ordinary agent turn required

Ask the agent to use `background_process` in `wait` mode for this harmless command (no service setup, files or network):

```sh
node -e 'let n=0; const t=setInterval(()=>{console.log("line",++n); if(n===120)clearInterval(t)},500)'
```

1. Open `/ps` while it is running. Recognize the task by its command, not only an opaque ID; check directory, state, duration and output.
2. Tab opens logs. Home/Page Up lets you read earlier retained output; it is marked paused.
3. End returns to live tail; new output appears. The log pane shows a bounded retained tail, not a guarantee of unlimited history.
4. Tab opens details. Read the complete wrapped command and directory; ID/mode/PID are secondary here.
5. S then Escape keeps it running. S then Enter requests stop. Check feedback/state; a process that already exited must not be presented as successfully stopped.
6. Escape closes. `/stop <id>` remains available outside the panel.

## 8. Context — no agent turn needed

1. Open `/context`; inspect Budget, Files, Skills, Tools, Conversation, Instructions and Provider payload with Tab/Shift+Tab.
2. Each panel should explain what question it answers, and keep the active panel name visible on narrow widths.
3. In an inventory, select an item and Enter to open full details. Scroll to the end of long content; Escape returns to the same selection.
4. Raw instructions/provider payload remain accessible and scrollable. Merely inspecting must not add an entry to the conversation.

## 9. Accounts — only if the opt-in extension is installed

1. Open `/codex-accounts` (or Ctrl+Alt+A). Do not add/login/refresh accounts just to test navigation.
2. Tab/Shift+Tab switches the viewed account without activating it.
3. Active **in this session** and default **for new sessions** must remain distinct.
4. G moves between Use account / Manage / With confirmation action groups; no action is executed by browsing.
5. V opens full origin, quotas/renewal, and consequences. Scroll and resize. Escape returns to actions; another Escape closes.
6. Existing reset/removal confirmations remain mandatory. Do not redeem a reset or remove credentials merely to validate appearance. Quota refresh explicitly contacts the provider.

## Report a problem

Send panel name, exact keys, terminal dimensions, regular/fullscreen mode, expected versus actual behavior, and a screenshot with private data redacted. Check both first use and returning after interruption; a screen fitting its bounds is not enough if information or consequences become inaccessible.
