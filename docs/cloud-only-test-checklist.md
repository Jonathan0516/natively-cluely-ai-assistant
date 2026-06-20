# Cloud-Only Migration — Manual Test Checklist

Runtime regression checklist for the LLM/STT cloud-only migration (branch
`feat/llm-gateway-quota-ends-meeting`). The desktop app no longer holds any LLM/STT
provider keys — every call goes through the backend gateway. Work top to bottom.

**Priority:** 3.1 (summary) > 4 (quota force-end) > 1.2/1.3 (vision) > 8.1 (no local
fallback). These are the deepest changes and most likely to break.

## 0. Prerequisites (skip these and everything below is a false result)
- [ ] `npm install` (prunes the 4 removed SDK deps), then rebuild/launch
- [ ] **Signed in** (CloudClient needs the auth token; otherwise all LLM/STT → 401)
- [ ] Backend gateway running and reachable (`/llm/*`)
- [ ] Account **has quota** (for happy-path); also have a **quota≈0** state ready (for §4)
- [ ] Watch terminal logs + DevTools console: `[LLMHelper]`, `[EmbeddingPipeline]`, errors

## 1. LLM core paths (every entry point is now gateway-only)
- [ ] 1.1 Plain text question → streams an answer (`streamChat`)
- [ ] 1.2 Question with screenshot/image → answers about the image (multimodal)
- [ ] 1.3 Screenshot → solution/analysis → returns result (`generateWithVisionFallback`)
- [ ] 1.4 Debug mode (extra screenshots) → debug result
- [ ] 1.5 Live suggestion during a meeting → suggestion (`generateSuggestion`)
- [ ] 1.6 Follow-up email generation → works (`chatWithGemini` 5-arg path)
- [ ] 1.7 Company research / profile extraction (if exposed) → structured result (`generateJson`)

## 2. STT (already a cloud relay)
- [ ] 2.1 Start meeting → speak → **live transcript appears**
- [ ] 2.2 Both channels (interviewer + user) transcribe
- [ ] 2.3 Switch recognition language (audio tab selector) → takes effect
- [ ] 2.4 Brief network blip → STT reconnects (`stt-status: reconnecting → connected`)

## 3. ⭐ End meeting + background processing (test hardest)
- [ ] 3.1 End meeting → **title + summary auto-generated** (`generateMeetingSummary` — rerouted to gateway, only tsc-verified; most likely to silently break)
- [ ] 3.2 Meeting persisted, opens from history
- [ ] 3.3 RAG: ask about a past meeting → retrieves + answers (embedding path)
- [ ] 3.4 Console shows `[EmbeddingPipeline] Ready with provider: ...` (Cloud preferred; Local bundled fallback when offline)

## 4. ⭐ Quota exhausted → force-end (new behavior)
- [ ] 4.1 With quota maxed, ask / transcribe → **meeting is force-ended** (no local fallback)
- [ ] 4.2 Renderer receives `quota-exhausted` broadcast (hook for the upgrade prompt)
- [ ] 4.3 No double-end (chat + STT both 402 → ends only once)

## 5. Settings UI (key config removed + read-only panel)
- [ ] 5.1 Settings "AI" tab = **read-only Plan & Usage panel** (reads `/llm/quota` + `/llm/models`): credit bar, reset date, models listed available/locked by tier
- [ ] 5.2 Panel "Refresh" button works
- [ ] 5.3 **No API-key inputs / custom providers / connection tests anywhere on the AI tab**
- [ ] 5.4 Audio tab = **"Enable live transcription" toggle** (no 8-provider dropdown, no key inputs); on/off persists across settings reopen
- [ ] 5.5 Toggle off → meeting captures audio but no transcript; on → transcription resumes
- [ ] 5.6 SettingsPopup "Fast Response" toggle is **gone**

## 6. Model selector (now reads the cloud catalog)
- [ ] 6.1 Open model selector → **only plan-available cloud models** (`/llm/models`)
- [ ] 6.2 No Ollama / local / custom-provider entries
- [ ] 6.3 Pick a model → takes effect (`model-changed` broadcast; later questions use it)

## 7. Layout (banner removed)
- [ ] 7.1 Launcher top: "downloading local AI memory" banner gone; **empty spacer keeps the CTA centered**, layout intact

## 8. ⚠️ Negative / regression (the cost of cloud-only — must test)
- [ ] 8.1 **Kill network/backend** → asking should **error directly** (`gemini-stream-error`), no silent local fallback (this is intended — confirm it's a clean error, not a crash)
- [ ] 8.2 STT while offline → failure status, no hang
- [ ] 8.3 **Not signed in** + use AI → clean 401 failure, no white screen / crash
- [ ] 8.4 App startup does **not** try to launch Ollama / pull an embedding model (no `[OllamaManager]` / `ollama:pull` in logs)
- [ ] 8.5 App quit is clean (no "Kill Ollama" errors)

## 9. Smoke (confirm nothing basic got deleted by mistake)
- [ ] 9.1 Screenshots / move window / undetectable / disguise all work
- [ ] 9.2 Language settings (STT + AI response) save and apply
- [ ] 9.3 Modes / profile / calendar unaffected
