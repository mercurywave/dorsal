# Dorsal

No-frills inline AI coding assistant for Visual Studio Code. Dorsal talks to a
[llama.cpp](https://github.com/ggml-org/llama.cpp) server (`llama-server`) to provide:

* **Tab completions** - ghost-text inline completions as you type, using llama.cpp's
  `/infill` fill-in-middle endpoint.
* **Next edit suggestions** - after you make a change, Dorsal proposes a related
  follow-up edit elsewhere in the file (shown as strikethrough/ghost-text diff);
  press `Tab` to accept or `Escape` to dismiss.
* **Inline quick edits** - select code, press `Ctrl+I`, describe the change in
  plain English, and preview the diff before accepting (`Ctrl+Enter`) or
  cancelling (`Escape`).

## Requirements

Run a local llama.cpp server, e.g.:

```sh
llama-server -m your-model.gguf --port 8080
```

Dorsal talks to it over its REST API - no other setup is required.

## Extension Settings

All settings are under the `dorsal.*` prefix:

* `dorsal.llmServer.baseUrl` - LLM server URL (default `http://127.0.0.1:8080`). Works best with llama.cpp's `llama-server`.
* `dorsal.llmServer.model` - optional model name to request, for multi-model setups (e.g. llama-swap).
* `dorsal.llmServer.apiKey` - optional bearer token for the LLM server.

`dorsal.llmServer.model` is the default model for all features. Each feature can also override the
base URL, API key, and model; leave an override empty to use the default:

* `dorsal.completions.enabled` / `dorsal.completions.useInfillApi` / `dorsal.completions.debounceMs` / `dorsal.completions.maxTokens` /
  `dorsal.completions.model` / `dorsal.completions.baseUrl` / `dorsal.completions.apiKey` -
  tab completion behavior.
* `dorsal.nextEditSuggestions.enabled` / `dorsal.nextEditSuggestions.autoTrigger` /
  `dorsal.nextEditSuggestions.useInfillApi` / `dorsal.nextEditSuggestions.maxTokens` /
  `dorsal.nextEditSuggestions.model` / `dorsal.nextEditSuggestions.baseUrl` / `dorsal.nextEditSuggestions.apiKey` -
  next edit suggestion behavior.
* `dorsal.inlineEdit.maxTokens` / `dorsal.inlineEdit.model` / `dorsal.inlineEdit.baseUrl` / `dorsal.inlineEdit.apiKey` -
  response size, model, and server overrides for `Ctrl+I` inline edits.


## Commands & Keybindings

* `Dorsal: Suggest Next Edit` - manually request a next-edit suggestion.
* `Dorsal: Accept Next Edit Suggestion` (`Tab`) / `Dorsal: Dismiss Next Edit Suggestion` (`Escape`).
* `Dorsal: Edit with AI` (`Ctrl+I`) - open the inline edit prompt for the current selection.
* `Dorsal: Accept Inline Edit` (`Ctrl+Enter`) / `Dorsal: Cancel Inline Edit` (`Escape`).

## Known Issues

* Next edit suggestions rely on the model returning a strict, parseable format;
  malformed responses are silently skipped rather than shown.
* `useInfillApi` is enabled by default for completions and next-edit suggestions.
  Disable it for models without llama.cpp's `/infill` endpoint; Dorsal will use
  the OpenAI-compatible `/v1/chat/completions` endpoint instead.

