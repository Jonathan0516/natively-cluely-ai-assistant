import { LLMHelper } from "../LLMHelper";
import { SYSTEM_DESIGN_MODE_PROMPT } from "./prompts";

export class SystemDesignLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    async *generateStream(context: string, imagePaths?: string[]): AsyncGenerator<string> {
        if (!context.trim() && !imagePaths?.length) return;
        try {
            yield* this.llmHelper.streamChat(context, imagePaths, undefined, SYSTEM_DESIGN_MODE_PROMPT);
        } catch (error) {
            console.error("[SystemDesignLLM] Stream failed:", error);
            yield "Couldn't draw a system design diagram. Make sure the question is visible or stated, then try again.";
        }
    }
}
