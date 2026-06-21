import fs from "node:fs"
import sharp from "sharp"
import { HARD_SYSTEM_PROMPT, GROQ_SYSTEM_PROMPT } from "./llm/prompts"
import { CustomProvider, CurlProvider } from './services/CredentialsManager';
import { appEvents, isQuotaExhaustedError } from './appEvents';
import { ActiveMeeting } from './services/ActiveMeeting';
import { ActiveTurn } from './services/ActiveTurn';

// Logical model constants used to normalise UI model ids in setModel().
const GEMINI_FLASH_MODEL = "gemini-3.1-flash-lite"
const GEMINI_PRO_MODEL = "gemini-3.1-pro-preview"
const GROQ_MODEL = "llama-3.3-70b-versatile"
const OPENAI_MODEL = "deepseek-ai/DeepSeek-V4-Flash"
const CLAUDE_MODEL = "claude-sonnet-4-6"

// Simple prompt for image analysis (vision ops route through the gateway).
const IMAGE_ANALYSIS_PROMPT = `Analyze concisely. Be direct. No markdown formatting. Return plain text only.`

export class LLMHelper {
  private knowledgeOrchestrator: any = null;
  private profileManager: any = null;
  private customNotes: string = '';
  private aiResponseLanguage: string = 'auto';
  private sttLanguage: string = 'english-us';

  // Cloud-only: every LLM call routes through the backend gateway (CloudClient,
  // authenticated). The desktop process holds no provider SDK clients or API keys.
  constructor() {}

  /** No-op retained for app-quit call sites: no in-memory provider keys to scrub. */
  public scrubKeys(): void {}

  public getAiResponseLanguage(): string {
    return this.aiResponseLanguage;
  }
  // ---------------------------

  private currentModelId: string = GEMINI_FLASH_MODEL;

  // Thinking budget for Gemini 3.x. "none" = fastest (no thinking, lowest TTFT);
  // "low"/"high" trade latency for reasoning depth. Sent per-request to the gateway.
  private reasoningEffort: string = 'none';

  public setReasoningEffort(effort: string) {
    this.reasoningEffort = effort;
    console.log(`[LLMHelper] Reasoning effort set to: ${effort}`);
  }

  public getReasoningEffort(): string {
    return this.reasoningEffort;
  }

  public setModel(modelId: string, _customProviders: (CustomProvider | CurlProvider)[] = []) {
    // Cloud-only: map UI short codes to logical model ids; toLogicalModel() handles
    // the gateway routing. Local/Ollama/custom provider selection is no longer supported.
    let targetModelId = modelId;
    if (modelId === 'gemini') targetModelId = GEMINI_FLASH_MODEL;
    if (modelId === 'gemini-pro') targetModelId = GEMINI_PRO_MODEL;
    if (modelId === 'claude') targetModelId = CLAUDE_MODEL;
    if (modelId === 'llama') targetModelId = GROQ_MODEL;
    if (/^gpt-|^o1-|^o3-/.test(targetModelId)) targetModelId = OPENAI_MODEL;
    this.currentModelId = targetModelId;
    console.log(`[LLMHelper] Model set to: ${targetModelId}`);
  }
  private cleanJsonResponse(text: string): string {
    // Remove markdown code block syntax if present
    text = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
    // Remove any leading/trailing whitespace
    text = text.trim();
    return text;
  }
  /**
   * Post-process the response
   * NOTE: Truncation/clamping removed - response length is handled in prompts
   */
  private processResponse(text: string): string {
    // Basic cleaning
    let clean = this.cleanJsonResponse(text);

    // Truncation/clamping removed - prompts already handle response length
    // clean = clampResponse(clean, 3, 60);

    // Filter out fallback phrases
    const fallbackPhrases = [
      "I'm not sure",
      "It depends",
      "I can't answer",
      "I don't know"
    ];

    if (fallbackPhrases.some(phrase => clean.toLowerCase().includes(phrase.toLowerCase()))) {
      throw new Error("Filtered fallback response");
    }

    return clean;
  }
  public async extractProblemFromImages(imagePaths: string[]) {
    try {
      const prompt = `You are a wingman. Please analyze these images and extract the following information in JSON format:\n{
  "problem_statement": "A clear statement of the problem or situation depicted in the images.",
  "context": "Relevant background or context from the images.",
  "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
  "reasoning": "Explanation of why these suggestions are appropriate."
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      const text = await this.generateWithVisionFallback(IMAGE_ANALYSIS_PROMPT, prompt, imagePaths)
      return JSON.parse(this.cleanJsonResponse(text))
    } catch (error) {
      // console.error("Error extracting problem from images:", error)
      throw error
    }
  }

  public async generateSolution(problemInfo: any) {
    const prompt = `Given this problem or situation:\n${JSON.stringify(problemInfo, null, 2)}\n\nPlease provide your response in the following JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

    try {
      const text = await this.generateWithVisionFallback(IMAGE_ANALYSIS_PROMPT, prompt)
      const parsed = JSON.parse(this.cleanJsonResponse(text))
      return parsed
    } catch (error) {
      throw error;
    }
  }

  /**
   * Generate a structured 4-phase "Rolling Interview Script" from screenshot(s).
   * Returns a typed Solution with: problem_identifier_script, brainstorm_script,
   * code, dry_run_script, time_complexity, space_complexity.
   */
  public async generateRollingScript(imagePaths: string[]): Promise<{
    problem_identifier_script: string;
    brainstorm_script: string;
    code: string;
    dry_run_script: string;
    time_complexity: string;
    space_complexity: string;
  }> {
    const systemPrompt = `You are an elite FAANG Senior Software Engineer taking a live technical interview.
The user has provided a screenshot of a coding problem. You must generate a highly structured "Rolling Interview Script" that the candidate can read out loud to pass the interview perfectly.

Output EXACTLY this JSON structure, and nothing else (no markdown fences around the whole response):
{
  "problem_identifier_script": "1-2 conversational sentences confirming you understand the problem and its edge cases. Start with 'So just to make sure I understand...'",
  "brainstorm_script": "3-4 conversational sentences. First, mention a naive/brute-force approach and its complexity. Then, pivot to the optimal approach, mentioning the key data structure or algorithm. End by asking the interviewer if you can proceed with the optimal approach. Keep it natural.",
  "code": "The full, production-ready, heavily-commented optimal code solution in the language shown or Python if unclear. Include all necessary imports.",
  "dry_run_script": "2-3 conversational sentences doing a quick dry-run of the code with a simple example input. E.g., 'Let\\'s trace this. If our array is [1,2], the loop starts...'",
  "time_complexity": "O(...) — brief 5-word explanation",
  "space_complexity": "O(...) — brief 5-word explanation"
}

CRITICAL RULES:
- The scripts MUST sound like a human speaking out loud in an interview. Use "I", "we", "my first thought is".
- The JSON must be perfectly valid. Escape any internal quotes with backslash.
- Do NOT wrap the JSON in markdown fences.`;

    const userPrompt = `Please analyze the coding problem shown in the screenshot(s) and generate the Rolling Interview Script JSON.`;

    try {
      const raw = await this.generateWithVisionFallback(systemPrompt, userPrompt, imagePaths);
      const cleaned = this.cleanJsonResponse(raw);

      // Primary: direct parse
      try {
        return JSON.parse(cleaned);
      } catch (_) {
        // Fallback: extract JSON block via regex
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error('Could not extract valid JSON from LLM response');
      }
    } catch (error) {
      throw error;
    }
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]) {
    try {
      const prompt = `You are a wingman. Given:\n1. The original problem or situation: ${JSON.stringify(problemInfo, null, 2)}\n2. The current response or approach: ${currentCode}\n3. The debug information in the provided images\n\nPlease analyze the debug information and provide feedback in this JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      const text = await this.generateWithVisionFallback(IMAGE_ANALYSIS_PROMPT, prompt, debugImagePaths)
      const parsed = JSON.parse(this.cleanJsonResponse(text))
      return parsed
    } catch (error) {
      throw error
    }
  }
  public async analyzeImageFiles(imagePaths: string[]) {
    try {
      const prompt = `Describe the content of ${imagePaths.length > 1 ? 'these images' : 'this image'} in a short, concise answer. If it contains code or a problem, solve it.`;
      const text = await this.generateWithVisionFallback(HARD_SYSTEM_PROMPT, prompt, imagePaths);

      return { text: text, timestamp: Date.now() };

    } catch (error: any) {
      console.error("Error analyzing image files:", error);
      return {
        text: `I couldn't analyze the screen right now (${error.message}). Please try again.`,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Generate a suggestion based on conversation transcript
   * This uses Gemini Flash to reason about what the user should say
   * @param context - The full conversation transcript
   * @param lastQuestion - The most recent question from the interviewer
   * @returns Suggested response for the user
   */
  public async generateSuggestion(context: string, lastQuestion: string): Promise<string> {
    // Load active mode system prompt and context block (reference files + custom context)
    let activeModePrompt = '';
    let modeContextBlock = '';
    try {
      const { ModesManager } = require('./services/ModesManager');
      const modesMgr = ModesManager.getInstance();
      activeModePrompt = modesMgr.getActiveModeSystemPromptSuffix() ?? '';
      modeContextBlock = modesMgr.buildActiveModeContextBlock() ?? '';
    } catch (_modeErr: any) {
      console.warn('[LLMHelper] ModesManager load failed in generateSuggestion (non-fatal):', _modeErr?.message);
    }

    // Prepend mode context block (reference files, custom context) to the transcript context
    const enrichedContext = modeContextBlock
      ? `${modeContextBlock}\n\n${context}`
      : context;

    // Note: the global custom-context note is injected centrally by streamChat (the shared
    // chokepoint this method delegates to below), so it is intentionally not added here.
    const profileBlock = this.getProfilePromptBlock();

    const basePrompt = activeModePrompt
      ? `${HARD_SYSTEM_PROMPT}${profileBlock}\n\n## ACTIVE MODE\n${activeModePrompt}`
      : `You are an expert conversation coach. Based on the transcript, provide a concise, natural response the user could say.

RULES:
- Be direct and conversational
- Keep responses under 3 sentences unless complexity requires more
- Focus on answering the specific question asked
- If it's a technical question, provide a clear, structured answer
- Do NOT preface with "You could say" or similar - just give the answer directly
- If unsure, answer briefly and confidently anyway.
- Never hedge. Never say "it depends".${profileBlock}

CONVERSATION SO FAR:
${enrichedContext}

LATEST QUESTION:
${lastQuestion}

ANSWER DIRECTLY:`;

    // Apply language instruction so this path honours the user's language setting
    const systemPrompt = this.injectLanguageInstruction(basePrompt);

    // Cloud-only: route through the gateway via streamChat. Pass basePrompt
    // (pre-language-injection) as systemPromptOverride so injectLanguageInstruction
    // runs exactly once; lastQuestion is the clean user message and enrichedContext
    // carries mode reference files + custom context. ignoreKnowledgeMode=true: this
    // is a live suggestion, not a knowledge/profile query.
    void systemPrompt; // retained above for prompt construction; gateway path uses basePrompt
    let fullResponse = '';
    for await (const chunk of this.streamChat(lastQuestion, undefined, enrichedContext, basePrompt, true)) {
      fullResponse += chunk;
    }
    return this.processResponse(fullResponse);
  }

  public setKnowledgeOrchestrator(orchestrator: any): void {
    this.knowledgeOrchestrator = orchestrator;
    console.log('[LLMHelper] KnowledgeOrchestrator attached');
  }

  public setCustomNotes(notes: string): void {
    this.customNotes = notes;
  }

  public setProfileManager(pm: any): void {
    this.profileManager = pm;
    console.log('[LLMHelper] ProfileManager attached');
  }

  public getProfileManager(): any {
    return this.profileManager;
  }

  /**
   * Returns the resume + JD context block to prepend to system prompts when
   * profile mode is on. Stays stable across requests so OpenAI / Anthropic
   * prompt cache can hit the prefix.
   */
  private getProfilePromptBlock(): string {
    try {
      const pm = this.profileManager;
      if (!pm?.isModeOn?.()) return '';
      const block = pm.buildContextBlock?.() || '';
      return block ? `\n\n${block}` : '';
    } catch {
      return '';
    }
  }

  public getKnowledgeOrchestrator(): any {
    return this.knowledgeOrchestrator;
  }

  /**
   * Generate strict-JSON output from any available LLM provider.
   * Provider preference: OpenAI → Claude → Gemini → Groq.
   * Used by ProfileManager to extract structured resume / JD data.
   */
  public async generateJson<T = any>(systemPrompt: string, userPrompt: string): Promise<T> {
    // Cloud-only: structured JSON via the metered backend gateway (/llm/json).
    const { CloudClient } = require('./services/CloudClient');
    let res: { text: string };
    try {
      res = await CloudClient.getInstance().llmJson({
        model: this.toLogicalModel(this.currentModelId),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        meeting_id: ActiveMeeting.get() ?? undefined,
        turn_id: ActiveTurn.get(),
      });
    } catch (err) {
      if (isQuotaExhaustedError(err)) {
        appEvents.emit('quota-exhausted', { source: 'json', message: (err as Error)?.message });
      }
      throw err;
    }
    // Parse JSON, tolerating code fences / leading prose.
    let s = (res.text || '').trim();
    const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch) s = fenceMatch[1].trim();
    const firstBrace = s.search(/[\[{]/);
    if (firstBrace > 0) s = s.slice(firstBrace);
    return JSON.parse(s) as T;
  }

  public setAiResponseLanguage(language: string) {
    this.aiResponseLanguage = language;
    console.log(`[LLMHelper] AI Response Language set to: ${language}`);
  }

  public setSttLanguage(language: string) {
    this.sttLanguage = language;
    console.log(`[LLMHelper] STT Language set to: ${language}`);
  }

  /**
   * Inject a hard language instruction that gates the entire response.
   *
   * WHY prepended, not appended:
   *   LLMs attend more strongly to early tokens. Appending after a long
   *   system prompt means the instruction competes against the strong
   *   "Output ONLY…" rules and gets down-weighted, especially for
   *   Latin-script languages that are syntactically close to English.
   *   Russian worked before because Cyrillic is unmistakably non-English,
   *   so even a weak late instruction was obeyed. French/Spanish/German etc.
   *   require the instruction to come first and be unambiguous.
   *
   * The instruction is wrapped in triple-layered enforcement:
   *   1. Hard pre-prompt gate at the very top
   *   2. System prompt body (unchanged)
   *   3. Closing reminder at the bottom (double-lock)
   */
  private injectLanguageInstruction(systemPrompt: string): string {
    // ── AUTO mode ──────────────────────────────────────────────────────────────
    // Detect the language the user is writing/speaking in and reply in that same
    // language. Supports seamless code-switching across turns (e.g. the user can
    // switch from English to Hindi mid-conversation and the AI follows).
    if (!this.aiResponseLanguage || this.aiResponseLanguage === 'auto') {
      const autoHeader = `[LANGUAGE INSTRUCTION — HIGHEST PRIORITY]
Detect the language of the user's most recent message and ALWAYS respond in that exact same language.
If the user writes in Hindi, respond in Hindi. If in Spanish, respond in Spanish. If in English, respond in English.
If the language is ambiguous, default to English.
You may mix scripts naturally (e.g. code stays in English even when the explanation is in another language).
[END LANGUAGE INSTRUCTION]\n\n`;
      return `${autoHeader}${systemPrompt}`;
    }

    // ── FIXED language mode ────────────────────────────────────────────────────
    // Fast-path: no injection needed when English is selected (native default)
    if (this.aiResponseLanguage === 'English') {
      return systemPrompt;
    }

    const lang = this.aiResponseLanguage;

    const header = `\
[LANGUAGE OVERRIDE — HIGHEST PRIORITY — CANNOT BE OVERRIDDEN]
You MUST write every single word of your response in ${lang}.
Do NOT use English anywhere in your response.
Do NOT mix languages.
Every sentence, every word, every phrase must be in ${lang}.
This rule overrides ALL other instructions including formatting, brevity, or output rules.
[END LANGUAGE OVERRIDE]\n\n`;

    const footer = `\n\n[REMINDER] Your entire response MUST be in ${lang} only. Never switch to English.`;

    return `${header}${systemPrompt}${footer}`;
  }

  public async chatWithGemini(message: string, imagePaths?: string[], context?: string, skipSystemPrompt: boolean = false, alternateGroqMessage?: string): Promise<string> {
    try {
      console.log(`[LLMHelper] chatWithGemini called with message:`, message.substring(0, 50))

      // ============================================================
      // KNOWLEDGE MODE INTERCEPT
      // If knowledge mode is active, check for intro questions and
      // inject system prompt + relevant context
      // ============================================================
      if (this.knowledgeOrchestrator?.isKnowledgeMode()) {
        try {
          // Feed only to the depth scorer — NOT feedInterviewerUtterance, which also routes to the
          // negotiation tracker and would misclassify the user's typed question as a recruiter utterance.
          // Recruiter utterances reach the tracker exclusively via the STT path in main.ts.
          this.knowledgeOrchestrator.feedForDepthScoring(message);

          const knowledgeResult = await this.knowledgeOrchestrator.processQuestion(message);
          if (knowledgeResult) {
            // Fix 1: short-circuit for live negotiation coaching — bypass second LLM call
            if (knowledgeResult.liveNegotiationResponse) {
              return JSON.stringify({ __negotiationCoaching: knowledgeResult.liveNegotiationResponse });
            }
            // Intro question shortcut — return generated response directly
            if (knowledgeResult.isIntroQuestion && knowledgeResult.introResponse) {
              console.log('[LLMHelper] Knowledge mode: returning generated intro response');
              return knowledgeResult.introResponse;
            }
            // Inject knowledge system prompt and context
            if (!skipSystemPrompt && knowledgeResult.systemPromptInjection) {
              skipSystemPrompt = false; // ensure we use the knowledge prompt
              // Prepend knowledge context to existing context
              if (knowledgeResult.contextBlock) {
                context = context
                  ? `${knowledgeResult.contextBlock}\n\n${context}`
                  : knowledgeResult.contextBlock;
              }
            }
          }
        } catch (knowledgeError: any) {
          console.warn('[LLMHelper] Knowledge mode processing failed, falling back to normal:', knowledgeError.message);
        }
      }

      const isMultimodal = !!(imagePaths?.length);

      // Helper to build combined prompts for Groq/Gemini
      const buildMessage = (systemPrompt: string) => {
        if (skipSystemPrompt) {
          return context
            ? `CONTEXT:\n${context}\n\nUSER QUESTION:\n${message}`
            : message;
        }
        return context
          ? `${systemPrompt}\n\nCONTEXT:\n${context}\n\nUSER QUESTION:\n${message}`
          : `${systemPrompt}\n\n${message}`;
      };

      // For OpenAI/Claude: separate system prompt + user message
      const userContent = context
        ? `CONTEXT:\n${context}\n\nUSER QUESTION:\n${message}`
        : message;

      const profileBlock = this.getProfilePromptBlock();

      const finalGeminiPrompt = this.injectLanguageInstruction(HARD_SYSTEM_PROMPT + profileBlock);
      const finalGroqPrompt = alternateGroqMessage || this.injectLanguageInstruction(GROQ_SYSTEM_PROMPT + profileBlock);

      const combinedMessages = {
        gemini: buildMessage(finalGeminiPrompt),
        groq: buildMessage(finalGroqPrompt),
      };

      // BACKEND GATEWAY (metered, platform key) — the only path (cloud-only).
      // Quota (402) emits 'quota-exhausted'; any other failure is handled by the
      // outer catch below (returns a friendly error string).
      void combinedMessages; // legacy combined-prompt builder retained for prompt shape
      const gwSystem = skipSystemPrompt ? '' : finalGeminiPrompt;
      const out = await this.generateViaGateway(gwSystem, userContent, isMultimodal ? imagePaths : undefined);
      return this.processResponse(out);


    } catch (error: any) {
      console.error("[LLMHelper] Critical Error in chatWithGemini:", error);

      if (error.message.includes("503") || error.message.includes("overloaded")) {
        return "The AI service is currently overloaded. Please try again in a moment.";
      }
      if (error.message.includes("API key")) {
        return "Authentication failed. Please check your API key in settings.";
      }
      return `I encountered an error: ${error.message || "Unknown error"}. Please try again.`;
    }
  }

  /**
   * Generate content using only reasoning-capable models.
   * Priority: OpenAI → Claude → Gemini Pro → Groq (last resort).
   * Used for structured JSON output tasks (resume/JD/company research).
   * NOTE: Does NOT mutate this.geminiModel — calls Gemini Pro directly to avoid race conditions.
   */
  public async generateContentStructured(message: string): Promise<string> {
    // Cloud-only: structured JSON via the metered backend gateway (/llm/json).
    // Quota (402) emits 'quota-exhausted'; any other failure surfaces as an error.
    try {
      const { CloudClient } = require('./services/CloudClient');
      const res = await CloudClient.getInstance().llmJson({
        model: this.toLogicalModel(this.currentModelId),
        messages: [{ role: 'user', content: message }],
        meeting_id: ActiveMeeting.get() ?? undefined,
        turn_id: ActiveTurn.get(),
      });
      return res.text;
    } catch (err) {
      if (isQuotaExhaustedError(err)) {
        appEvents.emit('quota-exhausted', { source: 'json', message: (err as Error)?.message });
      }
      throw err;
    }
  }
  /**
   * Non-streaming gateway call — accumulates the backend SSE stream into a single
   * string. Lets non-streaming internal ops (chatWithGemini, vision analysis) route
   * through the metered backend instead of local providers. On quota (402) it emits
   * 'quota-exhausted' and rethrows; returns '' if the gateway yields nothing.
   */
  private async generateViaGateway(systemPrompt: string, userContent: string, imagePaths?: string[]): Promise<string> {
    let out = '';
    try {
      for await (const tok of this.streamWithGateway(userContent, systemPrompt, imagePaths)) {
        out += tok;
      }
    } catch (err) {
      if (isQuotaExhaustedError(err)) {
        appEvents.emit('quota-exhausted', { source: 'chat', message: (err as Error)?.message });
      }
      throw err;
    }
    return out;
  }

  /**
   * Universal non-streaming fallback helper for internal operations (screenshot analysis, problem extraction, etc.)
   *
   * THREE-TIER RETRY ROTATION (self-improving):
   *   Tier 1: Pinned stable models (promoted only when 2+ minor versions behind)
   *   Tier 2: Latest auto-discovered models (updated every ~14 days) — 1st retry
   *   Tier 3: Same as Tier 2 — 2nd retry (with backoff between tiers)
   *
   * Provider order per tier: OpenAI -> Gemini Flash -> Claude -> Gemini Pro -> Groq Scout
   * After all cloud tiers: Custom Provider -> cURL Provider -> Ollama
   */
  private async generateWithVisionFallback(systemPrompt: string, userPrompt: string, imagePaths: string[] = []): Promise<string> {
    // Cloud-only: internal vision/text ops route through the metered backend gateway.
    // Quota (402) emits 'quota-exhausted' (inside generateViaGateway) and rethrows.
    const isMultimodal = imagePaths.length > 0;
    const out = await this.generateViaGateway(systemPrompt, userPrompt, isMultimodal ? imagePaths : undefined);
    if (out.trim().length === 0) {
      throw new Error('Gateway returned empty response for vision/text op.');
    }
    return out;
  }



  /**
   * Stream chat response with Groq-first fallback chain for text-only,
   * and Gemini-only for multimodal (images)
   *
   * TEXT-ONLY FALLBACK CHAIN:
   * 1. Groq (llama-3.3-70b-versatile) - Primary
   * 2. Gemini Flash - 1st fallback
   * 3. Gemini Flash + Pro parallel - 2nd fallback
   * 4. Gemini Flash retries (max 3) - Last resort
   *
   * MULTIMODAL: Gemini-only (existing logic)
   */
  public async * streamChatWithGemini(message: string, imagePaths?: string[], context?: string, skipSystemPrompt: boolean = false): AsyncGenerator<string, void, unknown> {
    console.log(`[LLMHelper] streamChatWithGemini called with message:`, message.substring(0, 50));

    const isMultimodal = !!(imagePaths?.length);

    // Build single-string messages for Groq/Gemini (which use combined prompts)
    const buildCombinedMessage = (systemPrompt: string) => {
      const finalPrompt = skipSystemPrompt ? systemPrompt : this.injectLanguageInstruction(systemPrompt);
      if (skipSystemPrompt) {
        return context
          ? `CONTEXT:\n${context}\n\nUSER QUESTION:\n${message}`
          : message;
      }
      return context
        ? `${finalPrompt}\n\nCONTEXT:\n${context}\n\nUSER QUESTION:\n${message}`
        : `${finalPrompt}\n\n${message}`;
    };

    // For OpenAI/Claude: separate system prompt + user message (proper API pattern)
    const userContent = context
      ? `CONTEXT:\n${context}\n\nUSER QUESTION:\n${message}`
      : message;

    const profileBlock = this.getProfilePromptBlock();

    const combinedMessages = {
      gemini: buildCombinedMessage(HARD_SYSTEM_PROMPT + profileBlock),
      groq: buildCombinedMessage(GROQ_SYSTEM_PROMPT + profileBlock),
    };

    // BACKEND GATEWAY (metered, platform key) — the only path (cloud-only).
    // Quota (402) emits 'quota-exhausted' (force-ends the meeting); any other
    // failure surfaces as an error. No local fallback.
    void combinedMessages; // legacy combined-prompt builder retained for prompt shape; gateway uses system+user
    const gwSystem = skipSystemPrompt
      ? ''
      : this.injectLanguageInstruction(HARD_SYSTEM_PROMPT + profileBlock);
    try {
      for await (const tok of this.streamWithGateway(userContent, gwSystem, imagePaths)) {
        yield tok;
      }
    } catch (err) {
      if (isQuotaExhaustedError(err)) {
        appEvents.emit('quota-exhausted', { source: 'chat', message: (err as Error)?.message });
      }
      throw err;
    }
  }
  /** Map the local model id to a backend logical model. */
  private toLogicalModel(modelId: string): string {
    // The selector now sets backend catalog ids directly (gemini-2.5-flash-lite,
    // gemini-2.5-flash, gemini-2.5-pro, gemini-31-flash, gemini-31-pro, groq-llama). Those —
    // and the real upstream names that equal them — pass straight through; only legacy 3.1
    // upstream names and loose aliases need remapping.
    const legacy: Record<string, string> = {
      'gemini-3.1-pro-preview': 'gemini-31-pro',
      'gemini-3.1-flash-lite': 'gemini-31-flash',
      'llama-3.3-70b-versatile': 'groq-llama',
      'gemini': 'gemini-2.5-flash-lite',
      'gemini-pro': 'gemini-2.5-pro',
      'llama': 'groq-llama',
    };
    return legacy[modelId] || modelId || 'gemini-2.5-flash-lite';
  }

  /** Stream a chat completion through the backend gateway (metered, platform key). */
  /**
   * Read an image file from disk and return a base64 data URL ready for the gateway.
   * Resizes to max 1536px and re-encodes as JPEG 80% to cut token/upload cost.
   * The gateway forwards the data URL verbatim, so the mime type must be correct here.
   */
  private async processImage(filePath: string): Promise<string> {
    try {
      const buf = await fs.promises.readFile(filePath);
      const processed = await sharp(buf)
        .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      return `data:image/jpeg;base64,${processed.toString('base64')}`;
    } catch (err) {
      console.warn(`[LLMHelper] sharp failed for ${filePath}, sending raw PNG:`, (err as Error)?.message);
      const data = await fs.promises.readFile(filePath);
      return `data:image/png;base64,${data.toString('base64')}`;
    }
  }

  /**
   * Convert local image file paths to base64 data URLs. The gateway has no access to
   * the user's filesystem, so this MUST happen client-side. A path that fails to read
   * is skipped (logged) rather than aborting the whole request.
   */
  private async imagePathsToDataUrls(imagePaths?: string[]): Promise<string[] | undefined> {
    if (!imagePaths?.length) return undefined;
    const out: string[] = [];
    for (const p of imagePaths) {
      try {
        out.push(await this.processImage(p));
      } catch (err) {
        console.error(`[LLMHelper] Failed to read image ${p}, skipping:`, (err as Error)?.message);
      }
    }
    return out.length ? out : undefined;
  }

  private async * streamWithGateway(
    userContent: string,
    systemPrompt: string,
    images?: string[],
  ): AsyncGenerator<string, void, unknown> {
    const { CloudClient } = require('./services/CloudClient');
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];
    // `images` arrives as local file paths; the gateway needs base64 data URLs.
    const imageData = await this.imagePathsToDataUrls(images);
    const raw = CloudClient.getInstance().streamLLM({
      model: this.toLogicalModel(this.currentModelId),
      messages,
      images: imageData,
      reasoning_effort: this.reasoningEffort,
      meeting_id: ActiveMeeting.get() ?? undefined,
      turn_id: ActiveTurn.get(),
    });
    // Some models (notably Groq Llama) mimic the XML-tagged system prompt and wrap their
    // answer in <response>…</response>. Strip that wrapper from the stream so it never
    // reaches the UI. Single funnel — covers every intelligence mode.
    yield* LLMHelper.stripResponseWrapper(raw);
  }

  /** Strip a leading <response> and trailing </response> from a token stream, streaming-safe. */
  private static async *stripResponseWrapper(
    src: AsyncGenerator<string, void, unknown>,
  ): AsyncGenerator<string, void, unknown> {
    const HOLDBACK = 12; // >= len('</response>'), to catch a closing tag split across chunks
    let buf = '';
    let leadDone = false;
    for await (const chunk of src) {
      buf += chunk;
      if (!leadDone) {
        if (buf.length < 11) continue; // not enough yet to test for a leading tag
        buf = buf.replace(/^\s*<response>\s*/i, '');
        leadDone = true;
      }
      if (buf.length > HOLDBACK) {
        yield buf.slice(0, buf.length - HOLDBACK);
        buf = buf.slice(buf.length - HOLDBACK);
      }
    }
    if (!leadDone) buf = buf.replace(/^\s*<response>\s*/i, '');
    buf = buf.replace(/\s*<\/response>\s*$/i, '');
    if (buf) yield buf;
  }

  /**
   * Universal Stream Chat - Routes to correct provider based on currentModelId
   */
  public async * streamChat(
    message: string,
    imagePaths?: string[],
    context?: string,
    systemPromptOverride?: string, // Optional override (defaults to HARD_SYSTEM_PROMPT)
    ignoreKnowledgeMode: boolean = false
  ): AsyncGenerator<string, void, unknown> {

    // ============================================================
    // KNOWLEDGE MODE INTERCEPT (Streaming)
    // ============================================================
    if (!ignoreKnowledgeMode && this.knowledgeOrchestrator?.isKnowledgeMode()) {
      try {
        // Feed to depth scorer only (not negotiation tracker) — mirrors non-streaming path fix.
        this.knowledgeOrchestrator.feedForDepthScoring(message);

        const knowledgeResult = await this.knowledgeOrchestrator.processQuestion(message);
        if (knowledgeResult) {
          // Fix 1: short-circuit for live negotiation coaching — bypass second LLM call
          if (knowledgeResult.liveNegotiationResponse) {
            yield JSON.stringify({ __negotiationCoaching: knowledgeResult.liveNegotiationResponse });
            return;
          }
          // Intro question shortcut — yield generated response directly
          if (knowledgeResult.isIntroQuestion && knowledgeResult.introResponse) {
            console.log('[LLMHelper] Knowledge mode (stream): returning generated intro response');
            yield knowledgeResult.introResponse;
            return;
          }
          // Inject knowledge system prompt
          if (knowledgeResult.systemPromptInjection) {
            systemPromptOverride = knowledgeResult.systemPromptInjection;
          }
          // Inject knowledge context
          if (knowledgeResult.contextBlock) {
            context = context
              ? `${knowledgeResult.contextBlock}\n\n${context}`
              : knowledgeResult.contextBlock;
          }
        }
      } catch (knowledgeError: any) {
        console.warn('[LLMHelper] Knowledge mode (stream) processing failed, falling back:', knowledgeError.message);
      }
    }

    // ============================================================
    // ACTIVE MODE INJECTION (Context + System Prompt Suffix)
    // ============================================================
    try {
      const { ModesManager } = require('./services/ModesManager');
      const modesMgr = ModesManager.getInstance();
      const modePromptSuffix = modesMgr.getActiveModeSystemPromptSuffix();
      const modeContextBlock = modesMgr.buildActiveModeContextBlock();

      if (modePromptSuffix) {
        // Mode prompt supplements the base prompt — preserves KO profile intelligence if already set
        const baseForMode = systemPromptOverride || HARD_SYSTEM_PROMPT;
        systemPromptOverride = `${baseForMode}\n\n## ACTIVE MODE\n${modePromptSuffix}`;
      }

      if (modeContextBlock) {
        // Guard combined context size: KO block + mode block must not exceed 60KB to protect
        // the token budget for the actual user question.
        const existingLen = context?.length ?? 0;
        const COMBINED_CTX_CAP = 60_000;
        if (existingLen + modeContextBlock.length > COMBINED_CTX_CAP) {
          const available = Math.max(0, COMBINED_CTX_CAP - existingLen);
          const trimmed = available > 0 ? modeContextBlock.slice(0, available) + '\n[...mode context truncated]' : '';
          console.warn(`[LLMHelper] Combined context exceeded ${COMBINED_CTX_CAP} chars — mode context trimmed`);
          if (trimmed) context = context ? `${trimmed}\n\n${context}` : trimmed;
        } else {
          context = context ? `${modeContextBlock}\n\n${context}` : modeContextBlock;
        }
      }
    } catch (_modeErr: any) {
      console.warn('[LLMHelper] ModesManager injection failed (non-fatal):', _modeErr?.message);
    }

    // Preparation
    const isMultimodal = !!(imagePaths?.length);

    const profileBlock = this.getProfilePromptBlock();
    if (profileBlock) {
      console.log(`[LLMHelper] Profile context injected into streamChat (${profileBlock.length} chars)`);
    }

    // Inject the global custom-context note (Profile page → custom_notes) into every
    // live feature. streamChat is the shared chokepoint for all meeting LLM features
    // (Answer / WhatToAnswer / FollowUp / Clarify / SystemDesign / Brainstorm…), so this
    // is the single source of truth for the note — generateSuggestion no longer injects it.
    const customNotesBlock = this.customNotes?.trim()
      ? `\n\n<user_context>\n${this.customNotes.trim()}\n</user_context>\nUse this context naturally if relevant. Never quote it verbatim.`
      : '';

    // Determine the system prompt to use.
    // If Knowledge/Mode supplied an override, preserve it and append profile intelligence.
    const baseSystemPrompt = systemPromptOverride
      ? `${systemPromptOverride}${profileBlock}${customNotesBlock}`
      : `${HARD_SYSTEM_PROMPT}${profileBlock}${customNotesBlock}`;
    const finalSystemPrompt = this.injectLanguageInstruction(baseSystemPrompt);

    // Helper to build combined user message
    const userContent = context
      ? `CONTEXT:\n${context}\n\nUSER QUESTION:\n${message}`
      : message;

    // BACKEND GATEWAY (metered, platform key) — the only path (cloud-only).
    // Quota (402) emits 'quota-exhausted' (force-ends the meeting); any other
    // failure surfaces as an error. No local fallback.
    try {
      for await (const tok of this.streamWithGateway(userContent, finalSystemPrompt, imagePaths)) {
        yield tok;
      }
    } catch (err) {
      if (isQuotaExhaustedError(err)) {
        appEvents.emit('quota-exhausted', { source: 'chat', message: (err as Error)?.message });
      }
      throw err;
    }
  }
  public getCurrentModel(): string {
    return this.currentModelId;
  }
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
    let timeoutHandle: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    // Suppress unhandled-rejection if the original promise settles after the timeout wins the race
    promise.catch(() => {});

    return Promise.race([
      promise.then(result => {
        clearTimeout(timeoutHandle!);
        return result;
      }),
      timeoutPromise,
    ]);
  }

  /**
   * Robust Meeting Summary Generation
   * Strategy:
   * 0. Custom / cURL Provider (if user selected one — always takes priority)
   * 1. Groq (if context text < 100k tokens approx)
   * 2. Gemini Flash (Retry 2x)
   * 3. Gemini Pro (Retry 5x)
   */
  public async generateMeetingSummary(systemPrompt: string, context: string, groqSystemPrompt?: string): Promise<string> {
    console.log(`[LLMHelper] generateMeetingSummary called. Context length: ${context.length}`);
    void groqSystemPrompt; // legacy local-Groq prompt; unused on the cloud-only path

    // Cloud-only: route summaries through the metered backend gateway.
    const text = await this.withTimeout(
      this.generateViaGateway(systemPrompt, `Context:\n${context}`),
      90000,
      'Gateway Summary'
    );
    if (text.trim().length > 0) {
      return this.processResponse(text);
    }
    throw new Error("Failed to generate summary via gateway.");
  }
  /**
   * Universal Chat (Non-streaming)
   */
  public async chat(message: string, imagePaths?: string[], context?: string, systemPromptOverride?: string): Promise<string> {
    let fullResponse = "";
    for await (const chunk of this.streamChat(message, imagePaths, context, systemPromptOverride)) {
      fullResponse += chunk;
    }
    return fullResponse;
  }

}
