import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, X, Clock } from 'lucide-react';

// Account-page "Model Library" overlay. Lists the chat models exposed by /llm/models
// (tier-gated by the user's plan) with their per-1k-token credit pricing and a short
// human-facing blurb. Pricing comes from the backend catalog (price_in/price_out);
// the blurbs live in i18n (account.planUsage.library.desc.<id>) so they stay bilingual.

interface CatalogModel {
    id: string;
    label: string;
    tier: string;
    capabilities: string[];
    available: boolean;
    latency_hint?: string;
    price_in?: number;
    price_out?: number;
}

interface ModelLibraryModalProps {
    open: boolean;
    onClose: () => void;
}

// i18next treats "." as a nesting separator, so the dotted model ids ("gemini-2.5-pro")
// are stored under sanitized keys ("gemini-2_5-pro"). Mirror that when looking a blurb up.
const descKey = (id: string): string => id.replace(/\./g, '_');

const ModelLibraryModal: React.FC<ModelLibraryModalProps> = ({ open, onClose }) => {
    const { t } = useTranslation();
    const [models, setModels] = useState<CatalogModel[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await window.electronAPI.getLlmModels();
            setModels(list || []);
        } catch {
            setError(t('account.planUsage.library.error'));
        } finally {
            setLoading(false);
        }
    }, [t]);

    // Fetch when the overlay opens; close on Esc while it is open.
    useEffect(() => {
        if (!open) return;
        load();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, load, onClose]);

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="w-full max-w-2xl max-h-[82vh] flex flex-col rounded-2xl border border-border-subtle bg-bg-card shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-border-subtle">
                    <div>
                        <h2 className="text-[18px] font-extrabold text-text-primary tracking-tight">
                            {t('account.planUsage.library.title')}
                        </h2>
                        <p className="text-[13px] text-text-secondary mt-1">
                            {t('account.planUsage.library.subtitle')}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('account.planUsage.library.close')}
                        className="shrink-0 -mr-1.5 -mt-0.5 p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-input transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto px-6 py-4">
                    {loading && (
                        <div className="flex items-center justify-center gap-2 text-xs text-text-secondary py-12">
                            <Loader2 size={16} className="animate-spin" />
                            {t('account.planUsage.library.loading')}
                        </div>
                    )}

                    {!loading && error && (
                        <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-input p-3 text-xs text-text-secondary">
                            <AlertCircle size={15} className="text-amber-500 shrink-0 mt-0.5" />
                            <span>{error}</span>
                        </div>
                    )}

                    {!loading && !error && models.length === 0 && (
                        <div className="py-12 text-center text-[13px] text-text-secondary">
                            {t('account.planUsage.library.empty')}
                        </div>
                    )}

                    {!loading && !error && models.length > 0 && (
                        <ul className="flex flex-col gap-2.5">
                            {models.map((m) => {
                                const desc = t(`account.planUsage.library.desc.${descKey(m.id)}`, '');
                                const isPro = m.tier === 'pro';
                                return (
                                    <li
                                        key={m.id}
                                        className={`rounded-xl border border-border-subtle bg-bg-input p-4 ${m.available ? '' : 'opacity-60'}`}
                                    >
                                        <div className="flex items-center justify-between gap-3 flex-wrap">
                                            <div className="flex items-center gap-2.5 min-w-0">
                                                <span className="text-[14px] font-bold text-text-primary truncate">{m.label}</span>
                                                <span
                                                    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 ${
                                                        isPro
                                                            ? 'text-accent-primary bg-accent-secondary'
                                                            : 'text-text-tertiary bg-bg-component'
                                                    }`}
                                                >
                                                    {isPro ? t('account.planUsage.library.tierPro') : t('account.planUsage.library.tierFree')}
                                                </span>
                                                {m.latency_hint && (
                                                    <span className="flex items-center gap-1 text-[11px] text-text-tertiary shrink-0">
                                                        <Clock size={11} />
                                                        {m.latency_hint}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-3 text-[12px] tabular-nums shrink-0">
                                                <span className="text-text-secondary">
                                                    {t('account.planUsage.library.priceIn')}{' '}
                                                    <span className="font-bold text-text-primary">{m.price_in ?? '—'}</span>
                                                </span>
                                                <span className="text-text-secondary">
                                                    {t('account.planUsage.library.priceOut')}{' '}
                                                    <span className="font-bold text-text-primary">{m.price_out ?? '—'}</span>
                                                </span>
                                                <span className="text-[10.5px] text-text-tertiary">
                                                    {t('account.planUsage.library.priceUnit')}
                                                </span>
                                            </div>
                                        </div>
                                        {desc && (
                                            <p className="text-[12.5px] text-text-secondary mt-2 leading-relaxed">{desc}</p>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ModelLibraryModal;
