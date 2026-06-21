// Authored preview for AccountView (account-page scope).
// AccountView embeds PlanUsagePanel, which reads window.electronAPI — install a
// realistic mock before render. Dark theme is the app default.
import { AccountView } from 'natively';

if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', 'dark');
}

const MODELS = [
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', tier: 'free', capabilities: ['chat'], available: true },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'free', capabilities: ['chat'], available: true },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'pro', capabilities: ['chat', 'vision'], available: true },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', tier: 'pro', capabilities: ['chat', 'vision'], available: true },
];

const setApi = () => {
  (window as any).electronAPI = {
    getLlmQuota: async () => ({
      plan: 'pro',
      period_start: '2026-06-01T00:00:00Z',
      period_end: '2026-07-01T00:00:00Z',
      credits_total: 9999,
      credits_used: 379,
      credits_remaining: 9620,
    }),
    getLlmModels: async () => MODELS,
  };
};

/** The full account page — username + plan/usage + sign out. */
export const Default = () => {
  setApi();
  return (
    <div style={{ height: 640, background: 'var(--bg-primary)' }}>
      <AccountView phone="13800138000" onSignOut={() => {}} />
    </div>
  );
};
