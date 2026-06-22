import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw, Search, Download, ArrowLeft } from 'lucide-react';

import ModelLibraryModal from './ModelLibraryModal';

// Cloud-only Plan & Usage building blocks for the account page (AccountView).
// The desktop app no longer stores LLM/STT provider keys — every request is metered through
// the backend gateway. `UsageCreditCard` surfaces the user's credit quota (from /llm/quota,
// fetched by AccountView and passed in). `ModelUsageTable` shows per-model usage.
//
// NOTE: the Add funds / Billing buttons and the "Pay as you go" badge are hardcoded
// placeholders. The "Model Library" button IS wired — it opens ModelLibraryModal, which
// pulls live model pricing/blurbs from /llm/models. The per-meeting usage table below is
// real (fed by /llm/usage). Wire Add funds / Billing to billing endpoints later.

export interface Quota {
    plan: string;
    period_start: string;
    period_end: string;
    credits_total: number;
    credits_used: number;
    credits_remaining: number;
}

interface UsageCreditCardProps {
    quota: Quota | null;
    loading: boolean;
    error: string | null;
    onReload: () => void;
}

// One line per model used in a meeting. A meeting can switch models mid-way, so a kind holds
// one entry per distinct model. `rIn`/`rOut` are the model's credit rate per 1k tokens and
// `rAudio` per audio second (STT); `credits` is the billed amount from the backend (already
// rate-applied; we display it, not recompute). STT lines carry `audioSeconds` and no tokens.
export interface UsageModelLine {
    logo: string;
    org: string;
    model: string;
    input: number;
    output: number;
    audioSeconds: number;
    rIn: number;
    rOut: number;
    rAudio: number;
    credits: number;
}

// Usage grouped by category: "llm" (chat/Q&A), "stt" (transcription), "embedding" (RAG indexing).
export type UsageKind = 'llm' | 'stt' | 'embedding';

export interface UsageKindGroup {
    kind: UsageKind;
    input: number;
    output: number;
    audioSeconds: number;
    credits: number;
    models: UsageModelLine[];
}

export interface MeetingUsage {
    id: string;
    meeting: string;
    when: string;
    kinds: UsageKindGroup[];
}

const meetingTotals = (m: MeetingUsage) => {
    let input = 0, output = 0, audioSeconds = 0, credits = 0;
    for (const k of m.kinds) {
        input += k.input;
        output += k.output;
        audioSeconds += k.audioSeconds;
        credits += k.credits;
    }
    return { input, output, audioSeconds, credits };
};

const fmtAudio = (sec: number): string => {
    const s = Math.round(sec);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
};

const fmtDate = (iso: string): string => {
    try {
        return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return iso;
    }
};

/** Top-right card of the account page: remaining credit + cycle meter + actions. */
export const UsageCreditCard: React.FC<UsageCreditCardProps> = ({ quota, loading, error, onReload }) => {
    const { t } = useTranslation();
    const [libraryOpen, setLibraryOpen] = useState(false);

    const pct = quota && quota.credits_total > 0
        ? Math.min(100, Math.round((quota.credits_used / quota.credits_total) * 100))
        : 0;
    const near = pct >= 90;

    return (
        <section className="rounded-2xl border border-border-subtle bg-bg-card shadow-sm p-6 flex flex-col">
            <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-text-secondary">{t('account.planUsage.usageCredit')}</span>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-accent-primary bg-accent-secondary px-2 py-1 rounded-full">
                        {t('account.planUsage.payAsYouGo')}
                    </span>
                    <button
                        type="button"
                        onClick={onReload}
                        disabled={loading}
                        className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-50 transition-colors"
                    >
                        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                        {t('account.planUsage.refresh')}
                    </button>
                </div>
            </div>

            {loading && (
                <div className="flex items-center gap-2 text-xs text-text-secondary py-10 justify-center flex-1">
                    <Loader2 size={16} className="animate-spin" />
                    {t('account.planUsage.loading')}
                </div>
            )}

            {!loading && error && (
                <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-input p-3 text-xs text-text-secondary mt-4">
                    <AlertCircle size={15} className="text-amber-500 shrink-0 mt-0.5" />
                    <span>{error}</span>
                </div>
            )}

            {!loading && !error && quota && (
                <>
                    {/* Two-column body: remaining amount (left, divider) + meter & actions (right) */}
                    <div className="grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)] items-center gap-5 my-4">
                        <div className="sm:pr-8 sm:mr-8 sm:border-r border-border-muted">
                            <div className="flex items-baseline gap-1">
                                <span className="text-[40px] leading-none font-extrabold text-text-primary tracking-tight">
                                    {quota.credits_remaining.toLocaleString()}
                                </span>
                                <span className="text-[13px] font-semibold text-text-tertiary ml-1.5">
                                    {t('account.planUsage.remaining')}
                                </span>
                            </div>
                        </div>

                        <div className="min-w-0">
                            <div className="flex items-center justify-between text-[12px] font-semibold mb-2 gap-3">
                                <span className="text-text-primary truncate">
                                    <span className="text-accent-primary">{quota.credits_used.toLocaleString()}</span>{' '}
                                    {t('account.planUsage.usedOfCycle', { total: quota.credits_total.toLocaleString() })}
                                </span>
                                <span className="text-text-tertiary font-medium shrink-0">
                                    {t('account.planUsage.resets', { date: fmtDate(quota.period_end) })}
                                </span>
                            </div>
                            <div className="h-2 rounded-full bg-bg-component overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all ${near ? 'bg-amber-500' : 'bg-accent-primary'}`}
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <button type="button" className="text-[13px] font-semibold rounded-xl px-4 py-2.5 bg-text-primary text-bg-card hover:opacity-90 transition-opacity">
                            {t('account.planUsage.addFunds')}
                        </button>
                        <button type="button" className="text-[13px] font-semibold rounded-xl px-4 py-2.5 border border-border-muted text-text-primary hover:border-text-tertiary transition-colors">
                            {t('account.planUsage.billing')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setLibraryOpen(true)}
                            className="text-[13px] font-semibold rounded-xl px-4 py-2.5 border border-border-muted text-text-primary hover:border-text-tertiary transition-colors"
                        >
                            {t('account.planUsage.modelLibrary')}
                        </button>
                    </div>

                    {near && (
                        <div className="flex items-center gap-1.5 text-[11px] text-amber-500 mt-2">
                            <AlertCircle size={12} />
                            {t('account.planUsage.nearQuota')}
                        </div>
                    )}
                </>
            )}

            <ModelLibraryModal open={libraryOpen} onClose={() => setLibraryOpen(false)} />
        </section>
    );
};

const thCls = 'text-[10.5px] font-bold uppercase tracking-wider text-text-tertiary py-2.5';

interface UsageDetailsTableProps {
    data: MeetingUsage[];
    loading: boolean;
    onSelect: (meeting: MeetingUsage) => void;
}

/** Full-width per-meeting usage log. One row = one meeting (totals across all models used). */
export const UsageDetailsTable: React.FC<UsageDetailsTableProps> = ({ data, loading, onSelect }) => {
    const { t } = useTranslation();

    return (
        <section className="rounded-2xl border border-border-subtle bg-bg-card shadow-sm overflow-hidden">
            <div className="flex items-end justify-between gap-4 flex-wrap px-6 pt-5 pb-4">
                <div>
                    <h2 className="text-[18px] font-extrabold text-text-primary tracking-tight">{t('account.planUsage.usageDetailsTitle')}</h2>
                    <p className="text-[13px] text-text-secondary mt-1">{t('account.planUsage.usageDetailsSubtitle')}</p>
                </div>
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                        <input
                            type="text"
                            placeholder={t('account.planUsage.searchMeeting')}
                            className="h-9 w-[200px] pl-9 pr-3 rounded-lg border border-border-muted bg-bg-input text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-primary"
                        />
                    </div>
                    <button
                        type="button"
                        className="flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-border-muted bg-bg-input text-[13px] font-semibold text-text-primary hover:border-text-tertiary transition-colors shrink-0"
                    >
                        <Download size={16} />
                        {t('account.planUsage.export')}
                    </button>
                </div>
            </div>
            {(loading || data.length === 0) && (
                <div className="px-6 py-10 text-center text-[13px] text-text-secondary border-t border-border-subtle">
                    {loading ? t('account.planUsage.loading') : t('account.planUsage.noUsage')}
                </div>
            )}
            {!loading && data.length > 0 && (
            <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="bg-bg-input border-y border-border-subtle">
                            <th className={`${thCls} text-left px-6`}>{t('account.planUsage.thMeeting')}</th>
                            <th className={`${thCls} text-right px-4`}>{t('account.planUsage.thInput')}</th>
                            <th className={`${thCls} text-right px-4`}>{t('account.planUsage.thOutput')}</th>
                            <th className={`${thCls} text-right px-4`}>{t('account.planUsage.thCredits')}</th>
                            <th className={`${thCls} text-right px-6`}>{t('account.planUsage.thAction')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.map((m) => {
                            const tot = meetingTotals(m);
                            return (
                                <tr key={m.id} className="border-b border-border-subtle last:border-b-0 hover:bg-bg-item-surface/60 transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="text-[14px] font-semibold text-text-primary truncate max-w-[260px]">{m.meeting}</div>
                                        <div className="text-[12px] text-text-tertiary tabular-nums mt-0.5">{m.when}</div>
                                    </td>
                                    <td className="px-4 py-4 text-right text-[13.5px] font-semibold text-text-primary tabular-nums">
                                        {tot.input.toLocaleString()}
                                    </td>
                                    <td className="px-4 py-4 text-right text-[13.5px] font-semibold text-text-primary tabular-nums">
                                        {tot.output.toLocaleString()}
                                    </td>
                                    <td className="px-4 py-4 text-right text-[14px] font-bold text-accent-primary tabular-nums">
                                        {tot.credits.toLocaleString()}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <button
                                            type="button"
                                            onClick={() => onSelect(m)}
                                            className="text-[13.5px] font-bold text-accent-primary hover:underline"
                                        >
                                            {t('account.planUsage.detail')}
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            )}
        </section>
    );
};

interface UsageDetailViewProps {
    usage: MeetingUsage;
    onBack: () => void;
}

/** One usage category (LLM / STT / Embedding) rendered as a labeled section. STT shows audio
 *  seconds + per-second rate; LLM/Embedding show input/output tokens + per-1k rates. */
const KindSection: React.FC<{ group: UsageKindGroup }> = ({ group }) => {
    const { t } = useTranslation();
    const isStt = group.kind === 'stt';
    const kindLabel = t(`account.planUsage.kind.${group.kind}`);

    return (
        <div className="border-b border-border-subtle last:border-b-0">
            <div className="flex items-center justify-between px-6 pt-4 pb-2">
                <span className="text-[12px] font-bold uppercase tracking-wider text-text-secondary">{kindLabel}</span>
                <span className="text-[13px] font-bold text-accent-primary tabular-nums">
                    {group.credits.toLocaleString()} {t('account.planUsage.creditsUnit')}
                </span>
            </div>
            <table className="w-full border-collapse">
                <thead>
                    <tr className="border-b border-border-subtle">
                        <th className={`${thCls} text-left px-6`}>{t('account.planUsage.thModel')}</th>
                        {isStt ? (
                            <th className={`${thCls} text-right px-4`}>{t('account.planUsage.thAudio')}</th>
                        ) : (
                            <>
                                <th className={`${thCls} text-right px-4`}>{t('account.planUsage.thInput')}</th>
                                <th className={`${thCls} text-right px-4`}>{t('account.planUsage.thOutput')}</th>
                            </>
                        )}
                        <th className={`${thCls} text-right px-4`}>{t('account.planUsage.thRate')}</th>
                        <th className={`${thCls} text-right px-6`}>{t('account.planUsage.thCredits')}</th>
                    </tr>
                </thead>
                <tbody>
                    {group.models.map((l, i) => (
                        <tr key={l.model + i} className="border-b border-border-subtle last:border-b-0">
                            <td className="px-6 py-3.5">
                                <div className="flex items-center gap-2.5">
                                    <span className="w-[26px] h-[26px] rounded-lg bg-bg-component text-[10px] font-extrabold text-text-secondary grid place-items-center shrink-0">
                                        {l.logo}
                                    </span>
                                    <span className="text-[13px] font-semibold text-text-primary whitespace-nowrap">{l.model}</span>
                                </div>
                            </td>
                            {isStt ? (
                                <td className="px-4 py-3.5 text-right text-[13.5px] font-semibold text-text-primary tabular-nums">
                                    {fmtAudio(l.audioSeconds)}
                                </td>
                            ) : (
                                <>
                                    <td className="px-4 py-3.5 text-right text-[13.5px] font-semibold text-text-primary tabular-nums">
                                        {l.input.toLocaleString()}
                                    </td>
                                    <td className="px-4 py-3.5 text-right text-[13.5px] font-semibold text-text-primary tabular-nums">
                                        {l.output.toLocaleString()}
                                    </td>
                                </>
                            )}
                            <td className="px-4 py-3.5 text-right text-[12.5px] font-medium text-text-secondary tabular-nums whitespace-nowrap">
                                {isStt ? `${l.rAudio}×/s` : `${l.rIn}× / ${l.rOut}×`}
                            </td>
                            <td className="px-6 py-3.5 text-right text-[14px] font-bold text-accent-primary tabular-nums">
                                {l.credits.toLocaleString()}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

/** Per-meeting detail: usage grouped by category (LLM / STT / Embedding), each broken down
 *  per model with its credit rate and credits consumed, plus a meeting grand total. */
export const UsageDetailView: React.FC<UsageDetailViewProps> = ({ usage, onBack }) => {
    const { t } = useTranslation();
    const tot = meetingTotals(usage);

    return (
        <section className="rounded-2xl border border-border-subtle bg-bg-card shadow-sm overflow-hidden">
            <div className="px-6 pt-5 pb-4 border-b border-border-subtle">
                <button
                    type="button"
                    onClick={onBack}
                    className="flex items-center gap-1.5 text-[12.5px] font-semibold text-text-secondary hover:text-text-primary transition-colors mb-3"
                >
                    <ArrowLeft size={15} />
                    {t('account.planUsage.back')}
                </button>
                <h2 className="text-[18px] font-extrabold text-text-primary tracking-tight">{usage.meeting}</h2>
                <p className="text-[12.5px] text-text-tertiary tabular-nums mt-1">{usage.when}</p>
            </div>
            <div className="overflow-x-auto">
                {usage.kinds.map((g) => <KindSection key={g.kind} group={g} />)}
                <div className="flex items-center justify-between bg-bg-input border-t border-border-muted px-6 py-3.5">
                    <span className="text-[12px] font-bold uppercase tracking-wider text-text-secondary">{t('account.planUsage.total')}</span>
                    <span className="text-[15px] font-extrabold text-accent-primary tabular-nums">{tot.credits.toLocaleString()} {t('account.planUsage.creditsUnit')}</span>
                </div>
            </div>
            <p className="px-6 py-3.5 text-[12px] text-text-tertiary">{t('account.planUsage.creditFormula')}</p>
        </section>
    );
};
