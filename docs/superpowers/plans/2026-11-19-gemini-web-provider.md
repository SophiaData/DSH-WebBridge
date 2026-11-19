# Gemini Web Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register Gemini web chat as a usable DSH provider with safe textual tool calls and isolated conversation recovery, without changing ChatGPT behavior.

**Architecture:** Reuse existing Playwright, DSH provider and tool executor. Add Gemini-only DOM read semantics and a fail-closed text protocol parser. Keep Google Connected Apps native MCP as a separate feature until authenticated endpoint and account eligibility are verified.

**Tech Stack:** Node.js ESM, Playwright-core, DSH LLM provider, node:test.

---

### Task 1: Safe Gemini protocol parser

**Files:** Create `src/gemini-protocol.js`; create `scripts/gemini-provider-unit.mjs`.

- [ ] **Step 1: Write failing tests** for exact `<<<TOOL_CALLS>>>`/`<<<END_TOOL_CALLS>>>` delimiters; reject malformed JSON, truncated tool calls and non-object arguments; preserve plain Markdown and `<<<FINAL>>>` answers.
- [ ] **Step 2: Run** `node --test scripts/gemini-provider-unit.mjs`. **Expected:** failure before implementation.
- [ ] **Step 3: Implement** `parseGeminiReply(raw)` with `JSON.parse`, an array of `{name,arguments}` objects and no fenced-JSON auto-execution. Fail closed on protocol errors.
- [ ] **Step 4: Run** `node --test scripts/gemini-provider-unit.mjs`. **Expected:** pass.
- [ ] **Step 5: Commit** parser and tests with `git add src/gemini-protocol.js scripts/gemini-provider-unit.mjs && git commit -m 'feat(gemini): parse explicit web tool protocol safely'`.

### Task 2: Wire opt-in Gemini into the existing provider

**Files:** Modify `index.js`, `src/config.js`, `src/provider.js`, `package.json`; test `scripts/gemini-provider-unit.mjs`.

- [ ] **Step 1: Write failing tests** for `visibleSites`, Gemini model availability only when authenticated, Gemini tool-call chunks and blocked out-of-catalog requests, and no ChatGPT regressions.
- [ ] **Step 2: Run** `node --test scripts/gemini-provider-unit.mjs scripts/provider-chatgpt-unit.mjs`. **Expected:** failure on new expectations.
- [ ] **Step 3: Register** `parseGeminiReply` only for site `gemini` in `WebChatAdapter`; keep ChatGPT `parseReply: null` in its route. Use the existing DSH tool-call stream and execution policy, and reject unknown tool names before emitting tool calls.
- [ ] **Step 4: Inject** the bounded one-time Gemini text context and tool catalog into the first composer turn. Avoid relying on ChatGPT's attachment UI. Do not silently truncate an authorization catalogue.
- [ ] **Step 5: Run** `npm test` and `npm run build:client`. **Expected:** pass; no live Google access required.
- [ ] **Step 6: Commit** with `git add index.js src/config.js src/provider.js package.json scripts/gemini-provider-unit.mjs && git commit -m 'feat(gemini): expose authenticated DSH model with tool protocol'`.

### Task 3: Gemini reply state and duplicate-send prevention

**Files:** Create `src/gemini-dom.js`; modify `src/adapters.js`, `src/detect.js`, `src/session.js`; test `scripts/gemini-provider-unit.mjs`.

- [ ] **Step 1: Write failing mocked-DOM tests** for Quill editor-compatible user-query text, last visible model-response (excluding thoughts), new user-query confirmation, unchanged stale response, repeated answer and generation stop semantics.
- [ ] **Step 2: Run** `node --test scripts/gemini-provider-unit.mjs`. **Expected:** failure.
- [ ] **Step 3: Implement** Gemini-specific `buildGeminiReadExpression()` and dispatch from `buildReadExpression(adapter)` when `adapter.site === 'gemini'`. Include a route-scoped user query identity.
- [ ] **Step 4: Gate** Gemini reply acceptance on a confirmed new user query plus a new/changed assistant reply. Never retry an uncertain send.
- [ ] **Step 5: Run** `npm test` and `npm run test:smoke`. **Expected:** pass.
- [ ] **Step 6: Commit** with `git add src/gemini-dom.js src/adapters.js src/detect.js src/session.js scripts/gemini-provider-unit.mjs && git commit -m 'fix(gemini): detect reply turns and avoid duplicate sends'`.

### Task 4: Documentation, release safeguards, and PR

**Files:** Create `docs/GEMINI-WEB.md`; update `README.md`; preserve this implementation plan.

- [ ] **Step 1: Document** manual Google sign-in, Gemini model menu availability, MCP text protocol limitation, per-site session isolation and explicit account restrictions for native Connected Apps.
- [ ] **Step 2: Run** `npm test`, `npm run test:smoke`, `npm run build:client`, `git diff --check` and review staged diff.
- [ ] **Step 3: Commit** docs and changes with `git add docs/GEMINI-WEB.md docs/superpowers/plans/2026-11-19-gemini-web-provider.md README.md && git commit -m 'docs(gemini): guide and acceptance criteria'`.
- [ ] **Step 4: Push** `git push -u origin feat/gemini-web-provider` and open PR against `SophiaData/DSH-WebBridge:main`.
- [ ] **Step 5: Mark live Google account/browser and official OAuth Connected Apps tests as not run until actual account eligibility and remote endpoint are available.

**Safety gate:** No edits to the active installed plugin or user Chrome profile; no cookies/tokens in artifacts; all tools use the existing DSH policy. Do not merge before independent review and real-account acceptance.
