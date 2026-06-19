import { GoogleGenAI } from "@google/genai"
import Groq from "groq-sdk"
import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import fs from "fs"
import sharp from "sharp"
import { ModelVersionManager, ModelFamily, TextModelFamily } from './services/ModelVersionManager'
import {
  HARD_SYSTEM_PROMPT, GROQ_SYSTEM_PROMPT, OPENAI_SYSTEM_PROMPT, CLAUDE_SYSTEM_PROMPT,
  UNIVERSAL_SYSTEM_PROMPT, UNIVERSAL_ANSWER_PROMPT, UNIVERSAL_WHAT_TO_ANSWER_PROMPT,
  UNIVERSAL_RECAP_PROMPT, UNIVERSAL_FOLLOWUP_PROMPT, UNIVERSAL_FOLLOW_UP_QUESTIONS_PROMPT, UNIVERSAL_ASSIST_PROMPT,
  CUSTOM_SYSTEM_PROMPT, CUSTOM_ANSWER_PROMPT, CUSTOM_WHAT_TO_ANSWER_PROMPT,
  CUSTOM_RECAP_PROMPT, CUSTOM_FOLLOWUP_PROMPT, CUSTOM_FOLLOW_UP_QUESTIONS_PROMPT, CUSTOM_ASSIST_PROMPT
} from "./llm/prompts"
import { deepVariableReplacer, getByPath, injectImageIntoMessages } from './utils/curlUtils';
import curl2Json from "@bany/curl-to-json";
import { CustomProvider, CurlProvider } from './services/CredentialsManager';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { createProviderRateLimiters, RateLimiter } from './services/RateLimiter';
import { TokenUsageTracker } from './services/TokenUsageTracker';
import { appEvents, isQuotaExhaustedError } from './appEvents';
const execAsync = promisify(exec);

interface OllamaResponse {
  response: string
  done: boolean
}

// Model constant for Gemini 3 Flash
const GEMINI_FLASH_MODEL = "gemini-3.1-flash-lite"
const GEMINI_PRO_MODEL = "gemini-3.1-pro-preview"
const GROQ_MODEL = "llama-3.3-70b-versatile"
// OpenAI client slot is routed to Netmind (OpenAI-compatible) for chat completions.
// STT, embeddings, and realtime audio still hit api.openai.com via their own code paths.
const OPENAI_BASE_URL = "https://api.netmind.ai/inference-api/openai/v1"
const OPENAI_MODEL = "deepseek-ai/DeepSeek-V4-Flash"
const CLAUDE_MODEL = "claude-sonnet-4-6"
const MAX_OUTPUT_TOKENS = 65536
// Output cap for the Netmind (OpenAI-compatible) chat slot.
// This app is single-turn with short answers — prompts force 2-4 sentences for
// non-coding and a full code block for coding (rarely >2-3k tokens). OpenAI-compatible
// inference backends (vLLM/SGLang) pre-allocate KV cache from max_tokens for scheduling,
// so sending MAX_OUTPUT_TOKENS (65536) needlessly inflates time-to-first-token on Netmind.
// 4096 leaves comfortable headroom for the longest coding answer while cutting latency.
const NETMIND_MAX_OUTPUT_TOKENS = 4096
const CLAUDE_MAX_OUTPUT_TOKENS = 64000
const GROQ_TEXT_MAX_OUTPUT_TOKENS = 2048
const GROQ_FAST_TEXT_MAX_OUTPUT_TOKENS = 768

// Simple prompt for image analysis (not interview copilot - kept separate)
const IMAGE_ANALYSIS_PROMPT = `Analyze concisely. Be direct. No markdown formatting. Return plain text only.`

export class LLMHelper {
  private client: GoogleGenAI | null = null
  private groqClient: Groq | null = null
  private openaiClient: OpenAI | null = null
  private claudeClient: Anthropic | null = null
  private apiKey: string | null = null
  private groqApiKey: string | null = null
  private openaiApiKey: string | null = null
  private claudeApiKey: string | null = null
  private useOllama: boolean = false
  private ollamaModel: string = "llama3.2"
  private ollamaUrl: string = "http://localhost:11434"
  private ollamaStartedByApp: boolean = false;
  private geminiModel: string = GEMINI_FLASH_MODEL
  private customProvider: CustomProvider | null = null;
  private activeCurlProvider: CurlProvider | null = null;
  private groqFastTextMode: boolean = false;
  private knowledgeOrchestrator: any = null;
  private profileManager: any = null;
  private customNotes: string = '';
  private aiResponseLanguage: string = 'auto';
  private sttLanguage: string = 'english-us';

  // Rate limiters per provider to prevent 429 errors on free tiers
  private rateLimiters: ReturnType<typeof createProviderRateLimiters>;

  // Self-improving model version manager for vision analysis
  private modelVersionManager: ModelVersionManager;

  constructor(apiKey?: string, useOllama: boolean = false, ollamaModel?: string, ollamaUrl?: string, groqApiKey?: string, openaiApiKey?: string, claudeApiKey?: string) {
    this.useOllama = useOllama

    // Initialize rate limiters
    this.rateLimiters = createProviderRateLimiters();

    // Initialize model version manager
    this.modelVersionManager = new ModelVersionManager();

    // Initialize Groq client if API key provided
    if (groqApiKey) {
      this.groqApiKey = groqApiKey
      this.groqClient = new Groq({ apiKey: groqApiKey })
      console.log(`[LLMHelper] Groq client initialized with model: ${GROQ_MODEL}`)
    }

    // Initialize OpenAI-compatible client (routed to Netmind) if Netmind key in env
    // Falls back to the passed openaiApiKey only if NETMIND_API_KEY is absent.
    const netmindKey = process.env.NETMIND_API_KEY
    const chatKey = netmindKey || openaiApiKey
    if (chatKey) {
      this.openaiApiKey = chatKey
      this.openaiClient = new OpenAI({ apiKey: chatKey, baseURL: OPENAI_BASE_URL })
      console.log(`[LLMHelper] Chat client initialized (${netmindKey ? 'Netmind' : 'OpenAI key fallback'}) with model: ${OPENAI_MODEL}`)
    }

    // Initialize Claude client if API key provided
    if (claudeApiKey) {
      this.claudeApiKey = claudeApiKey
      this.claudeClient = new Anthropic({ apiKey: claudeApiKey })
      console.log(`[LLMHelper] Claude client initialized with model: ${CLAUDE_MODEL}`)
    }

    if (useOllama) {
      this.ollamaUrl = ollamaUrl || "http://localhost:11434"
      this.ollamaModel = ollamaModel || "gemma:latest" // Default fallback
    } else if (apiKey) {
      this.apiKey = apiKey
      // Initialize with v1alpha API version for Gemini 3 support
      this.client = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: { apiVersion: "v1alpha" }
      })
      // console.log(`[LLMHelper] Using Google Gemini 3 with model: ${this.geminiModel} (v1alpha API)`)
    } else {
      console.warn("[LLMHelper] No API key provided. Client will be uninitialized until key is set.")
    }
  }

  public setApiKey(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: { apiVersion: "v1alpha" }
    })
    console.log("[LLMHelper] Gemini API Key updated.");
  }

  public setGroqApiKey(apiKey: string) {
    this.groqClient = new Groq({ apiKey });
    console.log("[LLMHelper] Groq API Key updated.");
  }

  public setOpenaiApiKey(apiKey: string) {
    // The chat client slot is bound to Netmind via NETMIND_API_KEY in env.
    // If env key is missing, fall back to the provided OpenAI key against the same base URL
    // (works only if the URL is OpenAI-compatible — i.e. user has overridden NETMIND_API_KEY).
    const key = process.env.NETMIND_API_KEY || apiKey;
    this.openaiApiKey = key;
    this.openaiClient = new OpenAI({ apiKey: key, baseURL: OPENAI_BASE_URL });
    console.log("[LLMHelper] Chat client key updated.");
  }

  public setClaudeApiKey(apiKey: string) {
    this.claudeApiKey = apiKey;
    this.claudeClient = new Anthropic({ apiKey });
    console.log("[LLMHelper] Claude API Key updated.");
  }

  /**
   * Initialize the self-improving model version manager.
   * Should be called after all API keys are configured.
   * Triggers initial model discovery and starts background scheduler.
   */
  public async initModelVersionManager(): Promise<void> {
    this.modelVersionManager.setApiKeys({
      openai: this.openaiApiKey,
      gemini: this.apiKey,
      claude: this.claudeApiKey,
      groq: this.groqApiKey,
    });
    await this.modelVersionManager.initialize();
    console.log(this.modelVersionManager.getSummary());
  }

  /**
   * Scrub all API keys from memory to minimize exposure window.
   * Called on app quit.
   */
  public scrubKeys(): void {
    this.apiKey = null;
    this.groqApiKey = null;
    this.openaiApiKey = null;
    this.claudeApiKey = null;
    this.client = null;
    this.groqClient = null;
    this.openaiClient = null;
    this.claudeClient = null;
    // Destroy rate limiters
    if (this.rateLimiters) {
      Object.values(this.rateLimiters).forEach(rl => rl.destroy());
    }
    // Stop model version manager background scheduler
    this.modelVersionManager.stopScheduler();
    console.log('[LLMHelper] Keys scrubbed from memory');
  }

  public setGroqFastTextMode(enabled: boolean) {
    this.groqFastTextMode = enabled;
    console.log(`[LLMHelper] Groq Fast Text Mode: ${enabled}`);
  }

  public getGroqFastTextMode(): boolean {
    return this.groqFastTextMode;
  }

  public getAiResponseLanguage(): string {
    return this.aiResponseLanguage;
  }

  // --- Model Type Checkers ---
  private isOpenAiModel(modelId: string): boolean {
    // Includes Netmind-hosted models (deepseek-ai/*) — they ride the OpenAI-compatible chat client.
    return modelId.startsWith("gpt-") || modelId.startsWith("o1-") || modelId.startsWith("o3-") || modelId.includes("openai") || modelId.startsWith("deepseek-ai/");
  }

  private isClaudeModel(modelId: string): boolean {
    return modelId.startsWith("claude-");
  }

  private isGroqModel(modelId: string): boolean {
    return modelId.startsWith("llama-") || modelId.startsWith("mixtral-") || modelId.startsWith("gemma-") || modelId.startsWith("meta-llama/") || modelId.startsWith("qwen/") || modelId.startsWith("qwen-");
  }

  private isGeminiModel(modelId: string): boolean {
    return modelId.startsWith("gemini-") || modelId.startsWith("models/");
  }
  // ---------------------------

  private currentModelId: string = GEMINI_FLASH_MODEL;

  public setModel(modelId: string, customProviders: (CustomProvider | CurlProvider)[] = []) {
    // Map UI short codes to internal Model IDs
    let targetModelId = modelId;
    if (modelId === 'gemini') targetModelId = GEMINI_FLASH_MODEL;
    if (modelId === 'gemini-pro') targetModelId = GEMINI_PRO_MODEL;
    if (modelId === 'claude') targetModelId = CLAUDE_MODEL;
    if (modelId === 'llama') targetModelId = GROQ_MODEL;
    // OpenAI slot is now routed to Netmind. Any persisted gpt-* / o1- / o3- value
    // is rewritten to the Netmind-hosted model so stale settings don't hit
    // api.netmind.ai with an unknown model id.
    if (/^gpt-|^o1-|^o3-/.test(targetModelId)) targetModelId = OPENAI_MODEL;

    if (targetModelId.startsWith('ollama-')) {
      this.useOllama = true;
      this.ollamaModel = targetModelId.replace('ollama-', '');
      this.customProvider = null;
      this.activeCurlProvider = null;
      console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel}`);
      return;
    }

    const custom = customProviders.find(p => p.id === targetModelId);
    if (custom) {
      this.useOllama = false;
      this.customProvider = custom;
      this.activeCurlProvider = null;
      console.log(`[LLMHelper] Switched to Custom Provider: ${custom.name}`);
      return;
    }

    // Standard Cloud Models
    this.useOllama = false;
    this.customProvider = null;
    this.currentModelId = targetModelId;

    // Update specific model props if needed
    if (targetModelId === GEMINI_PRO_MODEL) this.geminiModel = GEMINI_PRO_MODEL;
    if (targetModelId === GEMINI_FLASH_MODEL) this.geminiModel = GEMINI_FLASH_MODEL;

    console.log(`[LLMHelper] Switched to Cloud Model: ${targetModelId}`);
  }

  public switchToCurl(provider: CurlProvider) {
    this.useOllama = false;
    this.customProvider = null;
    this.activeCurlProvider = provider;
    console.log(`[LLMHelper] Switched to cURL provider: ${provider.name}`);
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

    // Inject custom user notes into every suggestion when present
    const customNotesBlock = this.customNotes?.trim()
      ? `\n\n<user_context>\n${this.customNotes.trim()}\n</user_context>\nUse this context naturally if relevant. Never quote it verbatim.`
      : '';

    const profileBlock = this.getProfilePromptBlock();

    const basePrompt = activeModePrompt
      ? `${HARD_SYSTEM_PROMPT}${profileBlock}\n\n## ACTIVE MODE\n${activeModePrompt}${customNotesBlock}`
      : `You are an expert conversation coach. Based on the transcript, provide a concise, natural response the user could say.

RULES:
- Be direct and conversational
- Keep responses under 3 sentences unless complexity requires more
- Focus on answering the specific question asked
- If it's a technical question, provide a clear, structured answer
- Do NOT preface with "You could say" or similar - just give the answer directly
- If unsure, answer briefly and confidently anyway.
- Never hedge. Never say "it depends".${customNotesBlock}${profileBlock}

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
    const errors: string[] = [];

    const tryParse = (raw: string): T => {
      let s = (raw || '').trim();
      const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      if (fenceMatch) s = fenceMatch[1].trim();
      const firstBrace = s.search(/[\[{]/);
      if (firstBrace > 0) s = s.slice(firstBrace);
      return JSON.parse(s) as T;
    };

    const pickOpenAiModel = (): string => {
      if (this.isOpenAiModel(this.currentModelId)) return this.currentModelId;
      try {
        const tier1 = this.modelVersionManager.getTextTieredModels(TextModelFamily.OPENAI).tier1;
        if (tier1) return tier1;
      } catch { /* fall through */ }
      return 'gpt-4o-mini';
    };
    const pickClaudeModel = (): string => {
      if (this.isClaudeModel(this.currentModelId)) return this.currentModelId;
      try {
        const tier1 = this.modelVersionManager.getTextTieredModels(TextModelFamily.CLAUDE).tier1;
        if (tier1) return tier1;
      } catch { /* fall through */ }
      return CLAUDE_MODEL;
    };

    console.log('[LLMHelper.generateJson] start. clients available:', {
      openai: !!this.openaiClient,
      claude: !!this.claudeClient,
      gemini: !!this.client,
      groq: !!this.groqClient,
    });

    if (this.openaiClient) {
      const model = pickOpenAiModel();
      console.log(`[LLMHelper.generateJson] -> OpenAI (${model})`);
      try {
        const resp = await this.withTimeout(
          this.openaiClient.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            max_completion_tokens: 8192,
          }),
          90000,
          `OpenAI (${model})`
        );
        try { TokenUsageTracker.recordFromResponse('openai', model, resp); } catch {}
        const raw = resp.choices[0]?.message?.content || '';
        console.log(`[LLMHelper.generateJson] OpenAI returned ${raw.length} chars`);
        return tryParse(raw);
      } catch (e: any) {
        console.warn(`[LLMHelper.generateJson] OpenAI failed: ${e.message}`);
        errors.push(`OpenAI(${model}): ${e.message}`);
      }
    }

    if (this.claudeClient) {
      const model = pickClaudeModel();
      console.log(`[LLMHelper.generateJson] -> Claude (${model})`);
      try {
        const resp = await this.withTimeout(
          this.claudeClient.messages.create({
            model,
            max_tokens: 8192,
            system: systemPrompt + '\n\nReturn ONLY the JSON object. No prose.',
            messages: [{ role: 'user', content: userPrompt }],
          }),
          90000,
          `Claude (${model})`
        );
        try { TokenUsageTracker.recordFromResponse('anthropic', model, resp); } catch {}
        const block: any = (resp as any).content?.[0];
        const raw = block?.type === 'text' ? block.text : '';
        console.log(`[LLMHelper.generateJson] Claude returned ${raw.length} chars`);
        return tryParse(raw);
      } catch (e: any) {
        console.warn(`[LLMHelper.generateJson] Claude failed: ${e.message}`);
        errors.push(`Claude(${model}): ${e.message}`);
      }
    }

    if (this.client) {
      console.log('[LLMHelper.generateJson] -> Gemini');
      try {
        const resp = await this.client.models.generateContent({
          model: GEMINI_FLASH_MODEL,
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
          config: { responseMimeType: 'application/json' } as any,
        });
        try { TokenUsageTracker.recordFromResponse('gemini', GEMINI_FLASH_MODEL, resp); } catch {}
        const raw = (resp as any).text || '';
        console.log(`[LLMHelper.generateJson] Gemini returned ${raw.length} chars`);
        return tryParse(raw);
      } catch (e: any) {
        console.warn(`[LLMHelper.generateJson] Gemini failed: ${e.message}`);
        errors.push(`Gemini: ${e.message}`);
      }
    }

    if (this.groqClient) {
      console.log('[LLMHelper.generateJson] -> Groq');
      try {
        const resp = await this.groqClient.chat.completions.create({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' } as any,
          max_tokens: GROQ_TEXT_MAX_OUTPUT_TOKENS,
        });
        try { TokenUsageTracker.recordFromResponse('groq', GROQ_MODEL, resp); } catch {}
        const raw = resp.choices[0]?.message?.content || '';
        console.log(`[LLMHelper.generateJson] Groq returned ${raw.length} chars`);
        return tryParse(raw);
      } catch (e: any) {
        console.warn(`[LLMHelper.generateJson] Groq failed: ${e.message}`);
        errors.push(`Groq: ${e.message}`);
      }
    }

    throw new Error(
      errors.length
        ? `All JSON providers failed:\n${errors.join('\n')}`
        : 'No LLM provider configured. Add an OpenAI / Claude / Gemini / Groq API key in Settings.'
    );
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
    if (modelId === 'gemini-3.1-pro-preview') return 'answer-pro';
    return 'answer-fast';
  }

  /** Stream a chat completion through the backend gateway (metered, platform key). */
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
    yield* CloudClient.getInstance().streamLLM({
      model: this.toLogicalModel(this.currentModelId),
      messages,
      images,
    });
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

    // Determine the system prompt to use.
    // If Knowledge/Mode supplied an override, preserve it and append profile intelligence.
    const baseSystemPrompt = systemPromptOverride
      ? `${systemPromptOverride}${profileBlock}`
      : `${HARD_SYSTEM_PROMPT}${profileBlock}`;
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

  public isUsingOllama(): boolean {
    return this.useOllama;
  }

  public async getOllamaModels(): Promise<string[]> {
    const baseUrl = (this.ollamaUrl || "http://127.0.0.1:11434").replace('localhost', '127.0.0.1');

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000); // Fast 1s timeout

        const response = await fetch(`${baseUrl}/api/tags`, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) return [];

        const data = await response.json();
        if (data && data.models) {
            return data.models.map((m: any) => m.name);
        }

        return [];
    } catch (error: any) {
        // Silently catch connection refused/timeout errors.
        // OllamaManager handles logging the startup status.
        return [];
    }
  }

  public async forceRestartOllama(): Promise<boolean> {
    try {
      console.log("[LLMHelper] Attempting to force restart Ollama...");

      // 1. Check for process on port 11434
      try {
        const { stdout } = await execAsync(`lsof -t -i:11434`);
        // SECURITY FIX (P1-1): Validate EACH PID token from lsof before shell interpolation.
        // lsof -t returns one PID per line when multiple processes are on the port.
        const pids = stdout.trim().split(/\s+/).filter(p => /^\d+$/.test(p));
        for (const pid of pids) {
          console.log(`[LLMHelper] Found blocking PID: ${pid}. Killing...`);
          await execAsync(`kill -9 ${pid}`);
        }
        if (pids.length === 0 && stdout.trim()) {
          console.warn(`[LLMHelper] Unexpected lsof output (no valid PIDs): "${stdout.trim().substring(0, 50)}". Skipping kill.`);
        }
      } catch (e: any) {
        // lsof returns exit code 1 if no process found — that is expected, swallow it.
        // Only surface genuinely unexpected errors.
        if (!e.message?.includes('exit code 1') && e.code !== 1) {
          console.warn('[LLMHelper] lsof error (non-fatal):', e.message);
        }
      }

      // 2. Restart Ollama through the Manager (which handles polling and background spawn)
      // We don't want to use exec('ollama serve') here directly anymore to avoid duplicate tracking
      const { OllamaManager } = require('./services/OllamaManager');
      await OllamaManager.getInstance().init();

      return true;
    } catch (error) {
      console.error("[LLMHelper] Failed to restart Ollama:", error);
      return false;
    }
  }

  public getCurrentProvider(): "ollama" | "gemini" | "custom" {
    if (this.customProvider) return "custom";
    return this.useOllama ? "ollama" : "gemini";
  }

  public getCurrentModel(): string {
    if (this.customProvider) return this.customProvider.name;
    if (this.activeCurlProvider) return this.activeCurlProvider.id;
    return this.useOllama ? this.ollamaModel : this.currentModelId;
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

  public async switchToOllama(model?: string, url?: string): Promise<void> {
    this.useOllama = true;
    if (url) this.ollamaUrl = url;

    if (model) {
      this.ollamaModel = model;
    }
    // console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel} at ${this.ollamaUrl}`);
  }

  public async switchToGemini(apiKey?: string, modelId?: string): Promise<void> {
    if (modelId) {
      this.geminiModel = modelId;
    }

    if (apiKey) {
      this.apiKey = apiKey;
      this.client = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: { apiVersion: "v1alpha" }
      });
    } else if (!this.client) {
      throw new Error("No Gemini API key provided and no existing client");
    }

    this.useOllama = false;
    this.customProvider = null;
    // console.log(`[LLMHelper] Switched to Gemini: ${this.geminiModel}`);
  }

  public async switchToCustom(provider: CustomProvider): Promise<void> {
    this.customProvider = provider;
    this.useOllama = false;
    this.client = null;
    this.groqClient = null;
    this.openaiClient = null;
    this.claudeClient = null;
    console.log(`[LLMHelper] Switched to Custom Provider: ${provider.name}`);
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
