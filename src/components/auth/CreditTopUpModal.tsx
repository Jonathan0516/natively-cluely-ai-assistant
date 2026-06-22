import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { X, Loader2 } from "lucide-react"

interface Pack {
    id: string
    currency: string
    amount: number   // minor units (fen)
    credits: number
}

interface Props {
    open: boolean
    onClose: () => void
}

const fmtPrice = (currency: string, amount: number): string => {
    const major = amount / 100
    const symbol = currency === "cny" ? "¥" : currency.toUpperCase() + " "
    return `${symbol}${major}`
}

export const CreditTopUpModal: React.FC<Props> = ({ open, onClose }) => {
    const { t } = useTranslation()
    const [packs, setPacks] = useState<Pack[]>([])
    const [loading, setLoading] = useState(false)
    const [launching, setLaunching] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!open) return
        setLoading(true)
        setError(null)
        window.electronAPI
            .getBillingPacks()
            .then((p) => setPacks(p))
            .catch(() => setError(t("account.planUsage.topUpError")))
            .finally(() => setLoading(false))
    }, [open, t])

    const buy = async (packId: string) => {
        setLaunching(packId)
        setError(null)
        try {
            const { url } = await window.electronAPI.createBillingCheckout(packId)
            await window.electronAPI.openExternal(url)
            onClose()
        } catch {
            setError(t("account.planUsage.topUpError"))
        } finally {
            setLaunching(null)
        }
    }

    if (!open) return null

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
            <div
                className="w-[420px] max-w-[92vw] rounded-2xl border border-border-subtle bg-bg-card p-6 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between">
                    <div>
                        <h3 className="text-[16px] font-extrabold text-text-primary">{t("account.planUsage.topUpTitle")}</h3>
                        <p className="text-[12.5px] text-text-secondary mt-1">{t("account.planUsage.topUpSubtitle")}</p>
                    </div>
                    <button type="button" onClick={onClose} className="text-text-tertiary hover:text-text-primary">
                        <X size={18} />
                    </button>
                </div>

                {loading && (
                    <div className="flex items-center justify-center gap-2 py-10 text-text-secondary text-sm">
                        <Loader2 size={16} className="animate-spin" />
                    </div>
                )}

                {!loading && (
                    <div className="mt-4 flex flex-col gap-2">
                        {packs.map((p) => (
                            <button
                                key={p.id}
                                type="button"
                                disabled={launching !== null}
                                onClick={() => buy(p.id)}
                                className="flex items-center justify-between rounded-xl border border-border-muted px-4 py-3 hover:border-accent-primary disabled:opacity-50 transition-colors"
                            >
                                <span className="text-[14px] font-semibold text-text-primary">
                                    {t("account.planUsage.topUpCredits", { credits: p.credits.toLocaleString() })}
                                </span>
                                <span className="text-[14px] font-bold text-accent-primary">
                                    {launching === p.id ? t("account.planUsage.topUpLaunching") : fmtPrice(p.currency, p.amount)}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                {error && <p className="mt-3 text-[12px] text-amber-500">{error}</p>}
                <p className="mt-4 text-[11.5px] text-text-tertiary">{t("account.planUsage.topUpHint")}</p>
            </div>
        </div>
    )
}
