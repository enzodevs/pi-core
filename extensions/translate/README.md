# Local prompt translation

`/translate on` translates submitted PT-BR prompts into English **before** Pi adds them to the conversation. `/translate off` disables it and unloads the model; `/translate status` reports the session setting. It is off by default. No model-facing tool, skill, command transcript, system-prompt change, or extra message is registered. Only the translated user text reaches the agent.

The toggle is stored in a Pi custom entry excluded from model context. Reloading/resuming the same session restores it, tree navigation follows the active branch, and new sessions/forks start off. Model assets are shared, but enabled state is never global. The extension factory starts no process; `/translate on` loads the model and subsequent inputs reuse it. Shutdown/reload stops its owned process.

## Setup

Requires a recent `llama-server` on PATH with Gemma 3 support. Set `PI_TRANSLATE_LLAMA_SERVER` to an executable path if needed. GPU acceleration is selected by llama.cpp's available backends; CPU works too, but latency will differ. No Python dependency or sudo is required by this extension.

From this checkout:

```sh
make translate-install
make translate-test
```

`translate-install` downloads a revision-pinned, SHA-256-verified **TranslateGemma 4B Q6_K** model (3.2 GB) to `~/.pi/agent/pi-core/translate/`. It performs network access only during explicit setup. Review [Gemma's model terms](https://ai.google.dev/gemma/terms). [Original model](https://huggingface.co/google/translategemma-4b-it); [GGUF distributor](https://huggingface.co/bullerwins/translategemma-4b-it-GGUF).

Then reload Pi:

```text
/reload
/translate on
```

The runtime uses an owned, offline `llama-server` bound to IPv4 loopback on an ephemeral port with a random authentication key. It never connects to an external translation API or downloads models on activation. The exact TranslateGemma PT-BR→English text template is rendered in the local backend, not added to the main agent context. Requests are stateless single translations; no conversation history is sent to the translator. The generic chat parser is disabled because llama.cpp cannot automatically interpret TranslateGemma's specialized template; raw token completions use the actual model template.

## Preservation and failure behavior

Fenced/inline code, common paths and filenames, URLs, snake_case/camelCase identifiers, flags, numbers, image markers, angle-bracket tags, and single/double-quoted literals are masked and restored byte-for-byte. Use backticks for other technical identifiers that must remain exact. The translator must return every protected marker exactly once in the same order; otherwise the prompt is blocked. Literal-only input needs no inference.

Translation covers ordinary interactive/RPC user input, including steering/follow-up inputs. Slash commands, shell inputs, and messages produced by extensions bypass translation. Place this extension **before image-clipboard** so failed translation does not consume clipboard attachments. Image payloads are never sent to the translation model.

Prompts are capped at 32 KiB and split at whitespace into small inference chunks. Each chunk has a token budget, a 60-second request deadline, and bounded JSON output. Truncated/empty responses, malformed protected markers, missing model/runtime, and other failures never silently fall back to an untranslated or partial prompt.

In the TUI, a failed prompt returns to the editor if it is empty. `/translate recover` restores the last failed prompt without overwriting a newer draft; direct image payloads are retained in session memory for exact-text resubmission. If editing an image-bearing recovered draft, reattach its images. Use `/translate off` to deliberately send the original. Session changes discard failed-draft recovery; it is not written to disk. Original successful prompts are not stored separately.

## Limits and verification

The extension guarantees exact preservation for masked literals, not semantic equivalence of all natural language. Mixed-language text, misspellings, long prompts split into chunks, quoted natural language (kept literal), and unusual Markdown can reduce translation quality. TranslateGemma can paraphrase or miss nuances; benchmark representative prompts rather than assuming perfect translation or better downstream reasoning. English prompts may lead to English agent responses; no hidden response-language instruction is injected.

`make translate-test` exercises synthetic informal Portuguese, negative restrictions, code/path preservation, and exploratory intent against the real local model and reports timings. It is optional; regular tests stub inference and include a real Pi session/provider-boundary regression proving commands/state/template text do not enter model context.
