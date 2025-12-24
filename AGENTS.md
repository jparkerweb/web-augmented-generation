# AGENTS.md

This file provides guidance to AI coding agents like Claude Code (claude.ai/code), Cursor AI, Codex, Gemini CLI, GitHub Copilot, and other AI coding assistants when working with code in this repository.

## Project Overview

Web-Augmented Generation (WAG) - A Node.js CLI application that performs intelligent web searches via SearXNG, fetches and summarizes content, then generates LLM-powered responses using Ollama with web-sourced context.

## Commands

```bash
# Install dependencies
npm ci

# Run the application
node main.js "your question here"

# Using the interactive prompt (after adding ask-scripts to PATH)
ask
```

## Architecture

The application follows a single-module pipeline architecture in `main.js`:

```
User Query → rephraseForSearch() → searchWeb() → fetchAllWithConcurrency()
           → summarizeContent() → generateWithContext() → Console Output
```

### Key Functions (main.js)

| Function | Lines | Purpose |
|----------|-------|---------|
| `main()` | 238-335 | Orchestrates the entire pipeline |
| `searchWeb()` | 47-98 | Queries SearXNG with retry/backoff logic |
| `fetchWebContent()` | 115-157 | Extracts text using Readability + JSDOM |
| `fetchAllWithConcurrency()` | 165-191 | Fetches multiple URLs with concurrency limit |
| `rephraseForSearch()` | 219-236 | Optimizes queries via LLM |
| `generateWithContext()` | 193-217 | Generates final response via Ollama |
| `summarizeContent()` | 345-357 | Sentence-based content truncation |
| `containsContextInfo()` | 359-373 | Validates response quality via keyword matching |

### External Dependencies

- **Ollama**: Local LLM inference (configurable model)
- **SearXNG**: Privacy-focused search engine (self-hosted or public instance)
- **Readability** + **JSDOM**: Content extraction from web pages
- **Cheerio**: HTML parsing for search results

## Configuration

All configuration is via environment variables in `.env` (copy from `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server endpoint |
| `OLLAMA_MODEL` | `llama3.2` | LLM model to use |
| `SEARXNG_URL` | Required | SearXNG instance URL |
| `SEARXNG_FORMAT` | `html` | Response format (`html` or `json`) |
| `SEARXNG_URL_EXTRA_PARAMETER` | - | Auth keys or custom params |
| `NUM_URLS` | `5` | Number of search results to process |
| `FETCH_TIMEOUT_MS` | `5000` | Content fetch timeout |
| `MAX_CONCURRENT_FETCHES` | `3` | Max simultaneous URL fetches |
| `DISABLE_SSL_VALIDATION` | `true` | Skip SSL certificate validation |

## Error Handling

- Retry mechanism with exponential backoff (5 attempts, starting at 2000ms)
- Rate limit handling (HTTP 429)
- Timeout handling for content fetching
- Errors logged to `error_log.txt`, execution trace to `log.txt`

## Code Conventions

- ES Modules (`"type": "module"` in package.json)
- Node.js 16+ required
- Single-file application architecture
- Uses `ora` spinner for CLI progress feedback
