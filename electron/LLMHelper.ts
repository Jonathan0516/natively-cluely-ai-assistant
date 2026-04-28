import OpenAI from "openai";
import fs from "fs";
import sharp from "sharp";
import {
  HARD_SYSTEM_PROMPT,
  OPENAI_SYSTEM_PROMPT,
  CUSTOM_SYSTEM_PROMPT,
} from "./llm/prompts";
import { CustomProvider, CurlProvider } from "./services/CredentialsManager";

const OPENAI_MODEL = "gpt-5.4";
const OPENAI_TRANSCRIBE_MODEL = "gpt-4o-transcribe";
const MAX_OUTPUT_TOKENS = 65536;
const IMAGE_ANALYSIS_PROMPT = "Analyze concisely. Be direct. No markdown formatting. Return plain text only.";

export class LLMHelper {
  private openaiClient: OpenAI | null = null;
  private openaiApiKey: string | null = null;
  private currentModelId = OPENAI_MODEL;
  private customNotes = "";
  private aiResponseLanguage = "auto";
  private sttLanguage = "english-us";
  private knowledgeOrchestrator: any = null;

  constructor(
    _apiKey?: string,
    _useOllama: boolean = false,
    _ollamaModel?: string,
    _ollamaUrl?: string,
    _groqApiKey?: string,
    openaiApiKey?: string,
    _claudeApiKey?: string
  ) {
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    if (key) {
      this.setOpenaiApiKey(key);
    } else {
      console.warn("[LLMHelper] No OpenAI API key configured.");
    }
  }

  public setOpenaiApiKey(apiKey: string): void {
    this.openaiApiKey = apiKey.trim() || null;
    this.openaiClient = this.openaiApiKey ? new OpenAI({ apiKey: this.openaiApiKey }) : null;
    console.log(`[LLMHelper] OpenAI API key ${this.openaiClient ? "set" : "cleared"}.`);
  }

  public scrubKeys(): void {
    this.openaiApiKey = null;
    this.openaiClient = null;
    console.log("[LLMHelper] OpenAI key scrubbed from memory");
  }

  public async initModelVersionManager(): Promise<void> {
    return;
  }

  public setModel(modelId: string, _customProviders: Array<CustomProvider | CurlProvider> = []): void {
    if (modelId && !modelId.startsWith("ollama-") && modelId !== "natively") {
      this.currentModelId = modelId;
    } else {
      this.currentModelId = OPENAI_MODEL;
    }
    console.log(`[LLMHelper] Active OpenAI model: ${this.currentModelId}`);
  }

  public getCurrentProvider(): "openai" {
    return "openai";
  }

  public getCurrentModel(): string {
    return this.currentModelId;
  }

  public isUsingOllama(): boolean {
    return false;
  }

  public async getOllamaModels(): Promise<string[]> {
    return [];
  }

  public async forceRestartOllama(): Promise<boolean> {
    return false;
  }

  public getOpenaiClient(): OpenAI | null {
    return this.openaiClient;
  }

  public hasOpenai(): boolean {
    return !!this.openaiClient;
  }

  public setAiResponseLanguage(language: string): void {
    this.aiResponseLanguage = language || "auto";
  }

  public getAiResponseLanguage(): string {
    return this.aiResponseLanguage;
  }

  public setSttLanguage(language: string): void {
    this.sttLanguage = language || "english-us";
  }

  public setKnowledgeOrchestrator(orchestrator: any): void {
    this.knowledgeOrchestrator = orchestrator;
  }

  public getKnowledgeOrchestrator(): any {
    return this.knowledgeOrchestrator;
  }

  public setCustomNotes(notes: string): void {
    this.customNotes = notes || "";
  }

  public setGroqFastTextMode(_enabled: boolean): void {
    return;
  }

  public getGroqFastTextMode(): boolean {
    return false;
  }

  public async switchToOllama(_model?: string, _url?: string): Promise<void> {
    this.currentModelId = OPENAI_MODEL;
  }

  public async switchToGemini(_apiKey?: string, _modelId?: string): Promise<void> {
    this.currentModelId = OPENAI_MODEL;
  }

  public async switchToCustom(_provider: CustomProvider): Promise<void> {
    this.currentModelId = OPENAI_MODEL;
  }

  public async switchToCurl(_provider: CurlProvider): Promise<void> {
    this.currentModelId = OPENAI_MODEL;
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      this.ensureOpenAI();
      const result = await this.generateWithOpenai("Reply with OK.", "You are a health check.");
      return result.trim() ? { success: true } : { success: false, error: "Empty OpenAI response" };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  public async chat(message: string, imagePaths?: string[], context?: string, systemPromptOverride?: string): Promise<string> {
    return this.chatWithOpenAI(message, imagePaths, context, !!systemPromptOverride, systemPromptOverride);
  }

  public async chatWithGemini(
    message: string,
    imagePaths?: string[],
    context?: string,
    skipSystemPrompt: boolean = false,
    _alternateGroqMessage?: string
  ): Promise<string> {
    return this.chatWithOpenAI(message, imagePaths, context, skipSystemPrompt);
  }

  public async chatWithCurl(userMessage: string, systemPrompt?: string, imagePath?: string): Promise<string> {
    return this.generateWithOpenai(userMessage, systemPrompt || CUSTOM_SYSTEM_PROMPT, imagePath ? [imagePath] : undefined);
  }

  public async executeCustomProvider(
    _curlCommand: string,
    fullPrompt: string,
    systemPrompt: string,
    _userMessage: string,
    _context: string,
    imagePath?: string
  ): Promise<string> {
    return this.generateWithOpenai(fullPrompt, systemPrompt, imagePath ? [imagePath] : undefined);
  }

  public async *streamChatWithGemini(
    message: string,
    imagePaths?: string[],
    context?: string,
    skipSystemPrompt: boolean = false
  ): AsyncGenerator<string, void, unknown> {
    yield* this.streamChat(message, imagePaths, context, skipSystemPrompt ? "" : undefined);
  }

  public async *streamChat(
    message: string,
    imagePaths?: string[],
    context?: string,
    systemPromptOverride?: string,
    ignoreKnowledgeMode: boolean = false
  ): AsyncGenerator<string, void, unknown> {
    const intercepted = await this.tryKnowledgeIntercept(message, context, systemPromptOverride, ignoreKnowledgeMode);
    if (intercepted) {
      yield intercepted.response;
      return;
    }

    const finalContext = intercepted?.context ?? context;
    const finalSystemPrompt = intercepted?.systemPrompt ?? systemPromptOverride ?? OPENAI_SYSTEM_PROMPT;
    const userContent = finalContext ? `CONTEXT:\n${finalContext}\n\nUSER QUESTION:\n${message}` : message;
    yield* this.streamWithOpenai(userContent, this.injectLanguageInstruction(finalSystemPrompt), imagePaths);
  }

  public async *streamWithGroqOrGemini(
    message: string,
    imagePaths?: string[],
    context?: string,
    systemPromptOverride?: string
  ): AsyncGenerator<string, void, unknown> {
    yield* this.streamChat(message, imagePaths, context, systemPromptOverride);
  }

  public async generateContentStructured(message: string): Promise<string> {
    return this.generateWithOpenai(message, "Return only valid JSON. No markdown fences.");
  }

  public async generateMeetingSummary(systemPrompt: string, context: string, _groqSystemPrompt?: string): Promise<string> {
    return this.generateWithOpenai(`Context:\n${context}`, systemPrompt);
  }

  public async generateSuggestion(context: string, lastQuestion: string): Promise<string> {
    const prompt = `${this.customNotes ? `USER NOTES:\n${this.customNotes}\n\n` : ""}CONVERSATION:\n${context}\n\nLAST QUESTION:\n${lastQuestion}`;
    return this.generateWithOpenai(prompt, "Suggest the best concise response for the user. Return only the response text.");
  }

  public async analyzeImageFiles(imagePaths: string[]): Promise<{ text: string; timestamp: number }> {
    const text = await this.generateWithOpenai(
      `Describe the content of ${imagePaths.length > 1 ? "these images" : "this image"} in a concise answer. If it contains code or a problem, solve it.`,
      IMAGE_ANALYSIS_PROMPT,
      imagePaths
    );
    return { text, timestamp: Date.now() };
  }

  public async extractProblemFromImages(imagePaths: string[]): Promise<any> {
    const prompt = `Analyze these images and return only JSON:
{
  "problem_statement": "clear problem statement",
  "context": "relevant context",
  "suggested_responses": ["response"],
  "reasoning": "why"
}`;
    return JSON.parse(this.cleanJsonResponse(await this.generateWithOpenai(prompt, IMAGE_ANALYSIS_PROMPT, imagePaths)));
  }

  public async generateSolution(problemInfo: any): Promise<any> {
    const prompt = `Given this problem or situation:\n${JSON.stringify(problemInfo, null, 2)}\n\nReturn only JSON:
{
  "solution": {
    "code": "answer or code",
    "problem_statement": "restated problem",
    "context": "relevant context",
    "suggested_responses": ["response"],
    "reasoning": "why"
  }
}`;
    return JSON.parse(this.cleanJsonResponse(await this.generateWithOpenai(prompt, "Return only valid JSON.")));
  }

  public async generateRollingScript(imagePaths: string[]): Promise<{
    problem_identifier_script: string;
    brainstorm_script: string;
    code: string;
    dry_run_script: string;
    time_complexity: string;
    space_complexity: string;
  }> {
    const prompt = `Analyze the coding problem in the screenshot(s). Return exactly this JSON shape:
{
  "problem_identifier_script": "spoken confirmation",
  "brainstorm_script": "spoken approach discussion",
  "code": "full optimal code",
  "dry_run_script": "spoken dry run",
  "time_complexity": "O(...)",
  "space_complexity": "O(...)"
}`;
    return JSON.parse(this.cleanJsonResponse(await this.generateWithOpenai(prompt, "You are an elite senior software engineer. Return only valid JSON.", imagePaths)));
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]): Promise<any> {
    const prompt = `Original problem:\n${JSON.stringify(problemInfo, null, 2)}\n\nCurrent solution:\n${currentCode}\n\nAnalyze the debug image(s) and return only JSON with a "solution" object.`;
    return JSON.parse(this.cleanJsonResponse(await this.generateWithOpenai(prompt, "Return only valid JSON.", debugImagePaths)));
  }

  public async generateWithPro(contents: any[]): Promise<string> {
    return this.generateWithOpenai(this.contentsToText(contents), OPENAI_SYSTEM_PROMPT);
  }

  public async generateWithFlash(contents: any[]): Promise<string> {
    return this.generateWithOpenai(this.contentsToText(contents), OPENAI_SYSTEM_PROMPT);
  }

  public getGeminiClient(): null {
    return null;
  }

  public getGroqClient(): null {
    return null;
  }

  public hasGroq(): boolean {
    return false;
  }

  public getClaudeClient(): null {
    return null;
  }

  public hasClaude(): boolean {
    return false;
  }

  public setApiKey(_apiKey: string): void {
    console.warn("[LLMHelper] Gemini has been removed; ignoring setApiKey.");
  }

  public setGroqApiKey(_apiKey: string): void {
    console.warn("[LLMHelper] Groq has been removed; ignoring setGroqApiKey.");
  }

  public setClaudeApiKey(_apiKey: string): void {
    console.warn("[LLMHelper] Claude has been removed; ignoring setClaudeApiKey.");
  }

  public setNativelyKey(_key: string | null): void {
    console.warn("[LLMHelper] Natively API has been removed; ignoring setNativelyKey.");
  }

  private async chatWithOpenAI(
    message: string,
    imagePaths?: string[],
    context?: string,
    skipSystemPrompt: boolean = false,
    systemPromptOverride?: string
  ): Promise<string> {
    const intercepted = await this.tryKnowledgeIntercept(message, context, systemPromptOverride, false);
    if (intercepted?.response) return intercepted.response;

    const finalContext = intercepted?.context ?? context;
    const systemPrompt = skipSystemPrompt ? undefined : this.injectLanguageInstruction(intercepted?.systemPrompt ?? systemPromptOverride ?? OPENAI_SYSTEM_PROMPT);
    const userContent = finalContext ? `CONTEXT:\n${finalContext}\n\nUSER QUESTION:\n${message}` : message;
    return this.generateWithOpenai(userContent, systemPrompt, imagePaths);
  }

  private async generateWithOpenai(userMessage: string, systemPrompt?: string, imagePaths?: string[]): Promise<string> {
    this.ensureOpenAI();

    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: await this.buildUserContent(userMessage, imagePaths) });

    const response = await this.openaiClient!.chat.completions.create({
      model: this.currentModelId || OPENAI_MODEL,
      messages,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
    });

    return response.choices[0]?.message?.content || "";
  }

  private async *streamWithOpenai(userMessage: string, systemPrompt?: string, imagePaths?: string[]): AsyncGenerator<string, void, unknown> {
    this.ensureOpenAI();

    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: await this.buildUserContent(userMessage, imagePaths) });

    const stream = await this.openaiClient!.chat.completions.create({
      model: this.currentModelId || OPENAI_MODEL,
      messages,
      stream: true,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }

  private async buildUserContent(userMessage: string, imagePaths?: string[]): Promise<any> {
    if (!imagePaths?.length) return userMessage;

    const contentParts: any[] = [{ type: "text", text: userMessage }];
    for (const imagePath of imagePaths) {
      if (!fs.existsSync(imagePath)) continue;
      const image = await this.processImage(imagePath);
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      });
    }
    return contentParts;
  }

  private async processImage(imagePath: string): Promise<{ mimeType: string; data: string }> {
    try {
      const imageBuffer = await fs.promises.readFile(imagePath);
      const processedBuffer = await sharp(imageBuffer)
        .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      return { mimeType: "image/jpeg", data: processedBuffer.toString("base64") };
    } catch {
      const data = await fs.promises.readFile(imagePath);
      return { mimeType: "image/png", data: data.toString("base64") };
    }
  }

  private async tryKnowledgeIntercept(
    message: string,
    context?: string,
    systemPrompt?: string,
    ignoreKnowledgeMode: boolean = false
  ): Promise<{ response?: string; context?: string; systemPrompt?: string } | null> {
    if (ignoreKnowledgeMode || !this.knowledgeOrchestrator?.isKnowledgeMode()) return null;

    try {
      this.knowledgeOrchestrator.feedForDepthScoring?.(message);
      const result = await this.knowledgeOrchestrator.processQuestion(message);
      if (!result) return null;
      if (result.liveNegotiationResponse) {
        return { response: JSON.stringify({ __negotiationCoaching: result.liveNegotiationResponse }) };
      }
      if (result.isIntroQuestion && result.introResponse) {
        return { response: result.introResponse };
      }
      return {
        context: result.contextBlock ? (context ? `${result.contextBlock}\n\n${context}` : result.contextBlock) : context,
        systemPrompt: result.systemPromptInjection || systemPrompt,
      };
    } catch (error: any) {
      console.warn("[LLMHelper] Knowledge mode processing failed:", error.message);
      return null;
    }
  }

  private injectLanguageInstruction(systemPrompt: string): string {
    if (!this.aiResponseLanguage || this.aiResponseLanguage === "auto" || this.aiResponseLanguage === "English") {
      return systemPrompt;
    }
    return `[LANGUAGE OVERRIDE]\nRespond entirely in ${this.aiResponseLanguage}.\n\n${systemPrompt}`;
  }

  private cleanJsonResponse(text: string): string {
    return text
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
  }

  private contentsToText(contents: any[]): string {
    return contents
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return JSON.stringify(part);
      })
      .join("\n");
  }

  private ensureOpenAI(): void {
    if (!this.openaiClient) {
      throw new Error("OpenAI client not initialized. Add OPENAI_API_KEY or save an OpenAI key in Settings.");
    }
  }
}

export { OPENAI_MODEL, OPENAI_TRANSCRIBE_MODEL };
