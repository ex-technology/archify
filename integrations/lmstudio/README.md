# Archify × LM Studio

Generate Archify diagrams with a **local model served by [LM Studio](https://lmstudio.ai/)** — no cloud agent required. [日本語版 README](README_JA.md)

Archify is normally driven by a coding agent (Claude Code, Cursor, Codex…) that writes the typed JSON specification and runs the Archify CLI. This integration replaces the agent with a local model, in two ways:

| | How it works | Best for |
|---|---|---|
| **CLI** `archify-lmstudio` | Calls LM Studio's OpenAI-compatible API, then runs a deterministic *generate → validate → deliver → browser-check → repair* loop using the real Archify tooling. | Reliable results with local models; scripting. |
| **MCP server** `archify-mcp` | Adds Archify tools to LM Studio's chat window. The model reads the authoring guide, writes the JSON, and calls `archify_render` until it validates. | Working interactively in the LM Studio app (needs a model that handles tool calls well). |

Both use the unmodified Archify Skill in [`../../archify`](../../archify) for validation and HTML delivery. Nothing is sent anywhere except your local LM Studio server.

## Requirements

- Node.js 18.17 or newer
- LM Studio 0.3.17 or newer, with a chat model downloaded
- Model context length of **at least 16k tokens** (the authoring prompt alone is about 4–5k tokens)

Models that follow JSON Schemas well give the best results, for example `qwen3-coder-30b-a3b-instruct`, `openai/gpt-oss-20b` / `gpt-oss-120b`, or `google/gemma-4-31b`. Very small models (≈1–4B) usually cannot satisfy the schema.

## CLI

1. In LM Studio, load a model and start the server (**Developer** tab → **Start Server**, or `lms server start`). The default address is `http://localhost:1234`.
2. From the repository root:

```bash
node integrations/lmstudio/bin/archify-lmstudio.mjs "Diagram a web request: Browser calls the API, the API checks Redis, and a cache miss queries PostgreSQL and fills the cache."
```

The diagram type is detected automatically (pasted Mermaid headers, then `archify guide`, then the model itself). Output goes to `./archify-out/<type>-<timestamp>.html`, with the specification next to it as `.json`.

Revise an existing diagram by passing its specification:

```bash
node integrations/lmstudio/bin/archify-lmstudio.mjs --edit archify-out/architecture-20260927-120000.json "Add an authentication service in front of the API"
```

Other examples:

```bash
node integrations/lmstudio/bin/archify-lmstudio.mjs --list-models
node integrations/lmstudio/bin/archify-lmstudio.mjs -t sequence -m openai/gpt-oss-20b -o docs/checkout.html "Checkout: client -> API -> payment provider, with webhook callback"
node integrations/lmstudio/bin/archify-lmstudio.mjs --input flow.mmd --open
```

| Option | Default | Description |
|---|---|---|
| `-t, --type` | auto | `architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle` |
| `-o, --out` | `./archify-out/<type>-<time>.html` | Output HTML; the spec is written next to it as `.json` |
| `--edit <spec.json>` | | Revise an existing specification (updated in place only if the result validates) |
| `-i, --input <file>` | | Read the request from a file (`-` = stdin), e.g. Mermaid source |
| `-m, --model` | `$LMSTUDIO_MODEL`, else the loaded model | LM Studio model id |
| `--base-url` | `$LMSTUDIO_BASE_URL` or `http://localhost:1234/v1` | Another host/port, e.g. LM Studio on your LAN |
| `--api-key` | `$LMSTUDIO_API_KEY` | Only when LM Studio authentication is enabled |
| `--quality` | `showcase` | `showcase` or `standard` |
| `--strict` | off | Never fall back from showcase to standard |
| `--max-repairs` | `4` | Repair rounds after the first answer |
| `--temperature` | `0.2` | Sampling temperature |
| `--max-tokens` | LM Studio setting | Completion token limit |
| `--no-visual-check` | off | Skip the headless-Chrome check that the page fits desktop screens |
| `--open` | off | Open the HTML in your browser after delivery |
| `--archify-root` | `$ARCHIFY_ROOT` or `../../archify` | Use an installed Archify Skill instead of this checkout |
| `--json` | off | Print the result as JSON |

### What the loop does

1. Builds a system prompt from the diagram type's JSON Schema, `common.schema.json`, one example, and a condensed version of the Skill's authoring rules. Architecture diagrams use a coordinate-free grid example ([`examples/architecture.grid.json`](examples/architecture.grid.json)), which local models handle much better than pixel positions.
2. Streams the model's answer and extracts the JSON, tolerating `<think>` blocks, Markdown fences, and trailing commas.
3. Runs `archify validate --quality showcase --json`. On failure it sends the validator's diagnostics (including its suggested fixes) back to the model and asks for a corrected specification.
4. Delivers each valid candidate with `archify deliver` and runs `archify visual-check` in headless Chrome (about 3 seconds) at 1440×900 through 2048×1320. If the page overflows the screen, the measurements and a concrete `meta.viewBox` suggestion go back to the model. Without Chrome the check is skipped; set `ARCHIFY_CHROME` to point at Chrome or Chromium.
5. Always keeps the best candidate so far. It stops after two rounds without improvement, following the Skill's repair rule.
6. Re-delivers the best candidate and re-runs the browser check, so the HTML, JSON, and screenshots all describe the same artifact. If showcase still fails but the candidate passes the `standard` profile, it delivers at standard quality and **prints the remaining showcase issues**, which may be visible in the diagram. Use `--strict` to refuse this fallback. If nothing passes, it writes the best attempt to `<name>.rejected.json` and exits with code 1. An existing `--edit` specification is never overwritten by a failing result.

Local generation is slow. A 30B-class model can take several minutes per answer, and each repair round is another answer.

## MCP server (LM Studio chat)

In LM Studio, open **Program → Install → Edit mcp.json** and add the server. Use absolute paths:

```json
{
  "mcpServers": {
    "archify": {
      "command": "node",
      "args": ["C:/path/to/archify/integrations/lmstudio/bin/archify-mcp.mjs"],
      "env": {
        "ARCHIFY_OUT_DIR": "C:/Users/you/archify-out",
        "ARCHIFY_OPEN": "1"
      }
    }
  }
}
```

Then ask in a chat, for example:

```text
Use the archify tools to draw an architecture diagram: the browser calls the API, the API checks Redis, and a cache miss queries PostgreSQL and fills the cache.
```

| Tool | Purpose |
|---|---|
| `archify_authoring_guide` | Returns the rules, schema, and example for a type (or picks the type from the request) |
| `archify_render` | Validates the spec, writes `<name>.html` and `<name>.json` to `ARCHIFY_OUT_DIR`, and runs the browser check. On failure it returns diagnostics to fix |

`ARCHIFY_OUT_DIR` defaults to `~/archify-out`. Output names are sanitized so files stay inside that directory. With `ARCHIFY_OPEN=1` the HTML opens in your browser after delivery.

## Notes and limits

- **Languages.** The model writes diagram text in the language of your request. The Viewer's own UI supports only English and Simplified Chinese, so for other languages (e.g. Japanese) the buttons and menus stay in English while all diagram content is in your language.
- **Not supported.** Repository-evidence mode (source-linked components) and brand capture still need a full coding agent.
- **Visual review.** The browser check measures layout and fit. It does not judge aesthetics, so look at the result yourself. Screenshots are saved next to the HTML as `<name>.visual-check.*.png`.

## Tests

```bash
cd integrations/lmstudio
npm test
```

The tests use a mock LM Studio server and the real Archify CLI. They need no model.
