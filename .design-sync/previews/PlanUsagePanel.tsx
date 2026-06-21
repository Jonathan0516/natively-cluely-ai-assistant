// Authored preview for PlanUsagePanel (account-page scope).
// The panel reads its data from window.electronAPI.getLlmQuota()/getLlmModels(),
// which don't exist in the design runtime — each cell installs a mock with
// realistic data before rendering. Dark theme is the app default.
import { PlanUsagePanel } from 'natively';

if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', 'dark');
}

const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', tier: 'free', capabilities: ['chat'], available: true },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'free', capabilities: ['chat'], available: true },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'pro', capabilities: ['chat', 'vision'], available: true },
  { id: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash', tier: 'free', capabilities: ['chat'], available: true },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', tier: 'pro', capabilities: ['chat', 'vision'], available: true },
  { id: 'groq-llama-3.3', label: 'Groq Llama 3.3', tier: 'free', capabilities: ['chat'], available: true },
];

const setApi = (quota: any, models: any[]) => {
  (window as any).electronAPI = {
    getLlmQuota: async () => quota,
    getLlmModels: async () => models,
  };
};

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ maxWidth: 480, padding: 24, background: 'var(--bg-primary)', minHeight: 420 }}>
    {children}
  </div>
);

/** Pro plan, healthy quota — the common state. */
export const ProPlan = () => {
  setApi(
    {
      plan: 'pro',
      period_start: '2026-06-01T00:00:00Z',
      period_end: '2026-07-01T00:00:00Z',
      credits_total: 9999,
      credits_used: 379,
      credits_remaining: 9620,
    },
    GEMINI_MODELS,
  );
  return <Frame><PlanUsagePanel /></Frame>;
};

/** Free plan near the quota limit — amber warning, pro models locked. */
export const FreePlanNearQuota = () => {
  setApi(
    {
      plan: 'free',
      period_start: '2026-06-01T00:00:00Z',
      period_end: '2026-07-01T00:00:00Z',
      credits_total: 500,
      credits_used: 472,
      credits_remaining: 28,
    },
    GEMINI_MODELS.map((m) => (m.tier === 'pro' ? { ...m, available: false } : m)),
  );
  return <Frame><PlanUsagePanel /></Frame>;
};
