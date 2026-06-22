import { BrowserWindow } from "electron"

import { AuthStorage, StoredAuth } from "../AuthStorage"

/**
 * Main-process HTTP client for the Natively backend data API.
 *
 * This is the single gateway between the Electron app and the cloud: it injects the user's
 * access token (read from AuthStorage) on every request and enforces per-account data
 * isolation server-side. It mirrors the token-refresh behaviour of the renderer's `useAuth`
 * (`src/hooks/useAuth.ts`): proactive refresh when the access token is near expiry, and a
 * single reactive retry on a 401. If refresh fails the session is cleared and an
 * `auth-session-expired` event is broadcast so the renderer can drop to the login panel.
 */

const DEFAULT_BACKEND = "http://localhost:8765"
const REFRESH_LEAD_SECONDS = 60

// One usage category (LLM / STT / embedding) within a meeting or turn, broken down per model.
interface UsageModelLine {
  model: string; label: string
  input_tokens: number; output_tokens: number; audio_seconds: number; credits: number
  rate_input: number; rate_output: number; rate_audio: number
}
interface UsageKindLine {
  kind: 'llm' | 'stt' | 'embedding'
  input_tokens: number; output_tokens: number; audio_seconds: number; credits: number
  models: UsageModelLine[]
}

function backendUrl(): string {
  const raw = process.env.NATIVELY_BACKEND_URL || process.env.VITE_AUTH_BACKEND_URL || DEFAULT_BACKEND
  return raw.replace(/\/$/, "")
}

export class CloudError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = "CloudError"
  }
}

interface TokenResponse {
  user_id: string
  phone: string
  access_token: string
  refresh_token: string
  access_expires_in: number
  refresh_expires_in: number
}

function toStored(resp: TokenResponse): StoredAuth {
  const now = Math.floor(Date.now() / 1000)
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    user_id: resp.user_id,
    phone: resp.phone,
    access_expires_at: now + resp.access_expires_in,
    refresh_expires_at: now + resp.refresh_expires_in,
  }
}

export class CloudClient {
  private static instance: CloudClient | null = null
  private readonly storage = new AuthStorage()
  private refreshInflight: Promise<StoredAuth> | null = null

  static getInstance(): CloudClient {
    if (!CloudClient.instance) CloudClient.instance = new CloudClient()
    return CloudClient.instance
  }

  /** The signed-in user's id, or null if logged out. */
  getUserId(): string | null {
    return this.storage.read()?.user_id ?? null
  }

  isAuthenticated(): boolean {
    const a = this.storage.read()
    return !!a && a.refresh_expires_at > Math.floor(Date.now() / 1000)
  }

  // --------------------------------------------------------------------- //
  // Token management                                                      //
  // --------------------------------------------------------------------- //

  private broadcastSessionExpired(): void {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.webContents.send("auth-session-expired")
      } catch {
        /* window may be destroyed */
      }
    }
  }

  /** Refresh the token pair. Single-flight: concurrent callers share one refresh. */
  private async refresh(): Promise<StoredAuth> {
    if (this.refreshInflight) return this.refreshInflight
    this.refreshInflight = (async () => {
      const stored = this.storage.read()
      if (!stored) throw new CloudError(401, "not authenticated")
      try {
        const resp = await fetch(`${backendUrl()}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: stored.refresh_token }),
        })
        if (!resp.ok) throw new CloudError(resp.status, await resp.text())
        const fresh = toStored((await resp.json()) as TokenResponse)
        this.storage.write(fresh)
        return fresh
      } catch (err) {
        console.warn("[CloudClient] token refresh failed, clearing session:", err)
        this.storage.clear()
        this.broadcastSessionExpired()
        throw err instanceof CloudError ? err : new CloudError(401, String(err))
      } finally {
        this.refreshInflight = null
      }
    })()
    return this.refreshInflight
  }

  /** Return a valid access token, refreshing proactively if it is near expiry. */
  private async accessToken(): Promise<string> {
    const stored = this.storage.read()
    if (!stored) throw new CloudError(401, "not authenticated")
    const now = Math.floor(Date.now() / 1000)
    if (stored.refresh_expires_at <= now) {
      this.storage.clear()
      this.broadcastSessionExpired()
      throw new CloudError(401, "session expired")
    }
    if (stored.access_expires_at <= now + REFRESH_LEAD_SECONDS) {
      return (await this.refresh()).access_token
    }
    return stored.access_token
  }

  /** Public valid-access-token getter (refreshes proactively) for WS auth. */
  async getAccessToken(): Promise<string> {
    return this.accessToken()
  }

  /** ws(s):// base URL for streaming endpoints (mirrors the http backend base). */
  get wsBaseUrl(): string {
    return backendUrl().replace(/^http/, "ws")
  }

  // --------------------------------------------------------------------- //
  // Core request                                                          //
  // --------------------------------------------------------------------- //

  private async request<T>(method: string, path: string, body?: unknown, _retried = false): Promise<T> {
    const token = await this.accessToken()
    const resp = await fetch(`${backendUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (resp.status === 401 && !_retried) {
      // Access token rejected — refresh once and retry.
      await this.refresh()
      return this.request<T>(method, path, body, true)
    }
    if (!resp.ok) {
      const detail = await resp.text()
      throw new CloudError(resp.status, detail || resp.statusText)
    }
    if (resp.status === 204) return undefined as T
    const text = await resp.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  private get<T>(path: string) {
    return this.request<T>("GET", path)
  }
  private post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body ?? {})
  }
  private put<T>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body ?? {})
  }
  private patch<T>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body ?? {})
  }
  private del<T>(path: string) {
    return this.request<T>("DELETE", path)
  }

  // --------------------------------------------------------------------- //
  // Meetings                                                              //
  // --------------------------------------------------------------------- //

  getRecentMeetings(limit = 50) {
    return this.get<any[]>(`/meetings?limit=${limit}`)
  }
  getUnprocessedMeetings() {
    return this.get<any[]>(`/meetings/unprocessed`)
  }
  getMeetingDetails(id: string) {
    return this.get<{ meeting: any; transcripts: any[]; ai_interactions: any[] } | null>(
      `/meetings/${encodeURIComponent(id)}`,
    )
  }
  saveMeeting(payload: { meeting: any; transcripts: any[]; ai_interactions: any[] }) {
    return this.post<{ id: string }>(`/meetings`, payload)
  }
  updateMeetingTitle(id: string, title: string) {
    return this.patch<{ updated: boolean }>(`/meetings/${encodeURIComponent(id)}/title`, { title })
  }
  updateMeetingSummary(id: string, updates: Record<string, unknown>) {
    return this.patch<{ updated: boolean }>(`/meetings/${encodeURIComponent(id)}/summary`, updates)
  }
  deleteMeeting(id: string) {
    return this.del<{ deleted: boolean }>(`/meetings/${encodeURIComponent(id)}`)
  }

  // --------------------------------------------------------------------- //
  // Embeddings                                                            //
  // --------------------------------------------------------------------- //

  upsertChunks(meetingId: string, chunks: any[]) {
    return this.post(`/embeddings/chunks`, { meeting_id: meetingId, chunks })
  }
  upsertSummary(meetingId: string, summaryText: string, dim: number | null, embedding: number[] | null) {
    return this.post(`/embeddings/summary`, {
      meeting_id: meetingId,
      summary_text: summaryText,
      dim,
      embedding,
    })
  }
  searchChunks(body: {
    embedding: number[]
    dim?: number | null
    meeting_id?: string | null
    limit?: number
    min_similarity?: number
  }) {
    return this.post<any[]>(`/embeddings/search`, body)
  }
  searchSummaries(body: { embedding: number[]; dim?: number | null; limit?: number; min_similarity?: number }) {
    return this.post<any[]>(`/embeddings/search-summaries`, body)
  }
  deleteEmbeddings(meetingId: string) {
    return this.del(`/embeddings/meeting/${encodeURIComponent(meetingId)}`)
  }
  async chunksExist(meetingId: string): Promise<boolean> {
    const res = await this.get<{ has_chunks: boolean }>(
      `/embeddings/meeting/${encodeURIComponent(meetingId)}/exists`,
    )
    return !!res?.has_chunks
  }

  // --------------------------------------------------------------------- //
  // LLM gateway (metered, platform-held Gemini key)                       //
  // --------------------------------------------------------------------- //

  /** Compute embeddings on the backend (platform Gemini key, metered). `meetingId` attributes
   *  the usage to a meeting so embedding credits show in per-meeting Usage Details. */
  async llmEmbeddings(
    texts: string[],
    model?: string,
    meetingId?: string | null,
  ): Promise<{ embeddings: number[][]; dim: number; model: string }> {
    const body: { texts: string[]; model?: string; meeting_id?: string } = { texts }
    if (model) body.model = model
    if (meetingId) body.meeting_id = meetingId
    return this.post(`/llm/embeddings`, body)
  }

  /** Stream chat tokens from the backend gateway (SSE). Yields text deltas. */
  async *streamLLM(body: {
    model: string
    messages: { role: string; content: string }[]
    images?: string[]
    max_tokens?: number
    temperature?: number
    reasoning_effort?: string
    meeting_id?: string
    turn_id?: string
  }): AsyncGenerator<string, void, unknown> {
    const token = await this.accessToken()
    const resp = await fetch(`${backendUrl()}/llm/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (resp.status === 401) throw new CloudError(401, "not authenticated")
    if (resp.status === 402) throw new CloudError(402, "quota exhausted")
    if (!resp.ok || !resp.body) throw new CloudError(resp.status, `stream failed: ${resp.status}`)

    const reader = (resp.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const data = line.slice(6).trim()
          if (data === "[DONE]") return
          let obj: { delta?: string; error?: { message?: string } }
          try { obj = JSON.parse(data) } catch { continue }
          if (obj.error) throw new CloudError(502, obj.error?.message || "stream error")
          if (typeof obj.delta === "string") yield obj.delta
        }
      }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }
  }

  /** Non-streaming structured JSON generation via the gateway. */
  async llmJson(body: {
    model: string
    messages: { role: string; content: string }[]
    images?: string[]
    meeting_id?: string
    turn_id?: string
  }): Promise<{ text: string }> {
    return this.post(`/llm/json`, body)
  }

  /** Current plan + credit usage for the authenticated user. */
  getLlmQuota() {
    return this.get<{
      plan: string
      period_start: string
      period_end: string
      credits_total: number
      credits_used: number
      credits_remaining: number
      wallet_balance: number
    }>(`/llm/quota`)
  }

  /** Available credit top-up packs. */
  getBillingPacks() {
    return this.get<Array<{ id: string; currency: string; amount: number; credits: number }>>(
      `/billing/packs`,
    )
  }

  /** Create a Stripe Checkout session for a pack; returns the hosted checkout URL. */
  createBillingCheckout(packId: string) {
    return this.post<{ url: string }>(`/billing/checkout`, { pack_id: packId })
  }

  /** Models available to the user's plan (tier-gated). */
  getLlmModels() {
    return this.get<Array<{
      id: string
      label: string
      tier: string
      capabilities: string[]
      available: boolean
      latency_hint?: string
      price_in?: number
      price_out?: number
    }>>(`/llm/models`)
  }

  /** Per-meeting usage (current period): token/audio usage + credits, grouped by category
   *  (LLM / STT / embedding) then model. */
  getLlmUsage() {
    return this.get<Array<{
      meeting_id: string
      last_used: string
      input_tokens: number
      output_tokens: number
      audio_seconds: number
      credits: number
      kinds: UsageKindLine[]
    }>>(`/llm/usage`)
  }

  /** One meeting's usage broken down per turn (Q&A), then by category and model. */
  getMeetingUsage(meetingId: string) {
    return this.get<{
      meeting_id: string
      input_tokens: number
      output_tokens: number
      audio_seconds: number
      credits: number
      turns: Array<{
        turn_id: string | null
        calls: number
        input_tokens: number
        output_tokens: number
        audio_seconds: number
        credits: number
        kinds: UsageKindLine[]
      }>
    }>(`/llm/usage/meeting/${encodeURIComponent(meetingId)}`)
  }

  // --------------------------------------------------------------------- //
  // Modes                                                                 //
  // --------------------------------------------------------------------- //

  getModes() {
    return this.get<any[]>(`/modes`)
  }
  getActiveMode() {
    return this.get<any | null>(`/modes/active`)
  }
  createMode(body: { id: string; name: string; template_type: string; custom_context: string }) {
    return this.post(`/modes`, body)
  }
  updateMode(id: string, updates: { name?: string; template_type?: string; custom_context?: string }) {
    return this.patch(`/modes/${encodeURIComponent(id)}`, updates)
  }
  deleteMode(id: string) {
    return this.del(`/modes/${encodeURIComponent(id)}`)
  }
  setActiveMode(modeId: string | null) {
    return this.put(`/modes/set-active`, { mode_id: modeId })
  }
  getReferenceFiles(modeId: string) {
    return this.get<any[]>(`/modes/${encodeURIComponent(modeId)}/files`)
  }
  addReferenceFile(modeId: string, file: { id: string; file_name: string; content: string }) {
    return this.post(`/modes/${encodeURIComponent(modeId)}/files`, file)
  }
  deleteReferenceFile(fileId: string) {
    return this.del(`/modes/files/${encodeURIComponent(fileId)}`)
  }
  getNoteSections(modeId: string) {
    return this.get<any[]>(`/modes/${encodeURIComponent(modeId)}/sections`)
  }
  addNoteSection(modeId: string, section: { id: string; title: string; description: string; sort_order: number }) {
    return this.post(`/modes/${encodeURIComponent(modeId)}/sections`, section)
  }
  updateNoteSection(sectionId: string, updates: { title?: string; description?: string; sort_order?: number }) {
    return this.patch(`/modes/sections/${encodeURIComponent(sectionId)}`, updates)
  }
  deleteNoteSection(sectionId: string) {
    return this.del(`/modes/sections/${encodeURIComponent(sectionId)}`)
  }
  deleteAllNoteSections(modeId: string) {
    return this.del(`/modes/${encodeURIComponent(modeId)}/sections`)
  }

  // --------------------------------------------------------------------- //
  // Profile                                                               //
  // --------------------------------------------------------------------- //

  getProfile() {
    return this.get<any | null>(`/profile`)
  }
  putProfile(fields: Record<string, unknown>) {
    return this.put<any>(`/profile`, fields)
  }
  getCustomNotes() {
    return this.get<{ content: string }>(`/profile/notes`)
  }
  saveCustomNotes(content: string) {
    return this.put(`/profile/notes`, { content })
  }
  getResumeNodes() {
    return this.get<any[]>(`/profile/resume-nodes`)
  }
  replaceResumeNodes(nodes: any[]) {
    return this.put(`/profile/resume-nodes`, { nodes })
  }

  // --------------------------------------------------------------------- //
  // Settings / keybinds / app-state                                       //
  // --------------------------------------------------------------------- //

  getSettings() {
    return this.get<Record<string, unknown>>(`/settings`)
  }
  putSettings(data: Record<string, unknown>) {
    return this.put<Record<string, unknown>>(`/settings`, { data })
  }
  getKeybinds() {
    return this.get<any[]>(`/keybinds`)
  }
  putKeybinds(data: any[]) {
    return this.put<any[]>(`/keybinds`, { data })
  }
  async getAppState(key: string): Promise<string | null> {
    const res = await this.get<{ value: string | null }>(`/app-state/${encodeURIComponent(key)}`)
    return res?.value ?? null
  }
  setAppState(key: string, value: string) {
    return this.put(`/app-state/${encodeURIComponent(key)}`, { value })
  }
  deleteAppState(key: string) {
    return this.del(`/app-state/${encodeURIComponent(key)}`)
  }
}
