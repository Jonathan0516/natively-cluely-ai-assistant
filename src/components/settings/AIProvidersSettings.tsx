import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertCircle, RefreshCw, Lock, Check } from 'lucide-react';

// Cloud-only Plan & Usage panel.
// The desktop app no longer stores LLM/STT provider keys — every request is metered
// through the backend gateway. This panel surfaces the user's plan, credit quota, and
// the models their plan unlocks (read from /llm/quota and /llm/models).

interface Quota {
    plan: string;
    period_start: string;
    period_end: string;
    credits_total: number;
    credits_used: number;
    credits_remaining: number;
}

interface ModelInfo {
    id: string;
    label: string;
    tier: string;
    capabilities: string[];
    available: boolean;
}

const fmtDate = (iso: string): string => {
    try {
        return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return iso;
    }
};

export const AIProvidersSettings: React.FC = () => {
    const [quota, setQuota] = useState<Quota | null>(null);
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [q, m] = await Promise.all([
                window.electronAPI.getLlmQuota(),
                window.electronAPI.getLlmModels(),
            ]);
            setQuota(q);
            setModels(Array.isArray(m) ? m : []);
        } catch (e: any) {
            setError(e?.message || 'Failed to load plan & usage. Make sure you are signed in.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const pct = quota && quota.credits_total > 0
        ? Math.min(100, Math.round((quota.credits_used / quota.credits_total) * 100))
        : 0;
    const near = pct >= 90;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-semibold text-text-primary">Plan &amp; Usage</h3>
                    <p className="text-xs text-text-secondary mt-0.5">
                        AI and transcription run on the cloud — no API keys to configure.
                    </p>
                </div>
                <button
                    onClick={load}
                    disabled={loading}
                    className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50 transition-colors"
                    type="button"
                >
                    <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            {loading && (
                <div className="flex items-center gap-2 text-xs text-text-secondary py-8 justify-center">
                    <Loader2 size={16} className="animate-spin" />
                    Loading plan &amp; usage…
                </div>
            )}

            {!loading && error && (
                <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-input p-3 text-xs text-text-secondary">
                    <AlertCircle size={15} className="text-amber-500 shrink-0 mt-0.5" />
                    <span>{error}</span>
                </div>
            )}

            {!loading && !error && quota && (
                <>
                    {/* Plan + credit usage */}
                    <div className="rounded-lg border border-border-subtle bg-bg-input p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-text-secondary">Current plan</span>
                            <span className="text-xs font-semibold text-text-primary uppercase tracking-wide">
                                {quota.plan}
                            </span>
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-text-secondary">Credits used</span>
                                <span className="text-text-primary tabular-nums">
                                    {quota.credits_used.toLocaleString()} / {quota.credits_total.toLocaleString()}
                                </span>
                            </div>
                            <div className="h-2 rounded-full bg-bg-elevated overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all ${near ? 'bg-amber-500' : 'bg-accent-primary'}`}
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-text-secondary">
                                <span>{quota.credits_remaining.toLocaleString()} remaining</span>
                                <span>Resets {fmtDate(quota.period_end)}</span>
                            </div>
                        </div>

                        {near && (
                            <div className="flex items-center gap-1.5 text-[11px] text-amber-500">
                                <AlertCircle size={12} />
                                You&apos;re close to your quota. Upgrade to keep meetings running.
                            </div>
                        )}
                    </div>

                    {/* Available models */}
                    <div className="space-y-2">
                        <span className="text-xs text-text-secondary">Available models</span>
                        <div className="rounded-lg border border-border-subtle bg-bg-input divide-y divide-border-subtle">
                            {models.length === 0 && (
                                <div className="px-3 py-2.5 text-xs text-text-secondary">No models available.</div>
                            )}
                            {models.map((m) => (
                                <div key={m.id} className="flex items-center justify-between px-3 py-2.5">
                                    <div className="flex items-center gap-2 min-w-0">
                                        {m.available
                                            ? <Check size={14} className="text-emerald-500 shrink-0" />
                                            : <Lock size={13} className="text-text-secondary shrink-0" />}
                                        <span className={`text-xs truncate ${m.available ? 'text-text-primary' : 'text-text-secondary'}`}>
                                            {m.label}
                                        </span>
                                    </div>
                                    <span className="text-[10px] uppercase tracking-wide text-text-secondary px-1.5 py-0.5 rounded bg-bg-elevated shrink-0">
                                        {m.tier}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
