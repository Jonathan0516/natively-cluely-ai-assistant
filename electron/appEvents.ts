import { EventEmitter } from 'events';

/**
 * Process-wide event bus that decouples low-level helpers (LLMHelper, STT) from
 * the AppState meeting controller in main.ts.
 *
 * Currently used to signal QUOTA EXHAUSTION. The product rule is cloud-only:
 * when the platform quota runs out we force-end the meeting and prompt the user
 * to upgrade — we do NOT silently fall back to local providers (local AI is being
 * retired). Helpers emit 'quota-exhausted'; AppState listens and force-ends.
 */

export type QuotaSource = 'chat' | 'json' | 'stt';

export interface QuotaExhaustedPayload {
  /** Which subsystem hit the quota wall (for telemetry / UI copy). */
  source: QuotaSource;
  /** Human-readable detail from the gateway, if any. */
  message?: string;
}

interface AppEventMap {
  'quota-exhausted': [QuotaExhaustedPayload];
}

class AppEventBus extends EventEmitter {
  emit<K extends keyof AppEventMap>(event: K, ...args: AppEventMap[K]): boolean {
    return super.emit(event as string, ...args);
  }
  on<K extends keyof AppEventMap>(event: K, listener: (...args: AppEventMap[K]) => void): this {
    return super.on(event as string, listener as (...args: any[]) => void);
  }
}

/** Singleton bus shared across the main process. */
export const appEvents = new AppEventBus();

/**
 * True when an error originates from the backend gateway rejecting a call for
 * quota exhaustion (HTTP 402). CloudClient throws CloudError with `.status`.
 */
export function isQuotaExhaustedError(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 402;
}
