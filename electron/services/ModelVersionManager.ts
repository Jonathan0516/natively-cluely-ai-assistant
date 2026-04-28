const OPENAI_MODEL = 'gpt-5.4';

export interface ModelVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export enum ModelFamily {
  OPENAI = 'openai',
}

export enum TextModelFamily {
  OPENAI = 'text_openai',
}

export interface TieredModels {
  tier1: string;
  tier2: string;
  tier3: string;
}

export const VISION_PROVIDER_ORDER: ModelFamily[] = [ModelFamily.OPENAI];
export const TEXT_PROVIDER_ORDER: TextModelFamily[] = [TextModelFamily.OPENAI];

export function parseModelVersion(modelId: string): ModelVersion | null {
  const match = modelId.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    raw: modelId,
  };
}

export class ModelVersionManager {
  private apiKey: string | null = null;
  private model = OPENAI_MODEL;

  setApiKeys(keys: { openai?: string | null; gemini?: string | null; claude?: string | null; groq?: string | null }): void {
    this.apiKey = keys.openai || null;
  }

  async initialize(): Promise<void> {
    return;
  }

  stopScheduler(): void {
    return;
  }

  getSummary(): string {
    return `[ModelVersionManager] OpenAI-only model: ${this.model}`;
  }

  getTieredModels(_family: ModelFamily): TieredModels {
    return { tier1: this.model, tier2: this.model, tier3: this.model };
  }

  getTextTieredModels(_family: TextModelFamily): TieredModels {
    return { tier1: this.model, tier2: this.model, tier3: this.model };
  }

  async onModelError(_providerName: string): Promise<void> {
    return;
  }
}
