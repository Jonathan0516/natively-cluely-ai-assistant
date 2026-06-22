import React, { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { LogOut, User } from "lucide-react"

import { MeetingUsage, Quota, UsageCreditCard, UsageDetailsTable, UsageDetailView } from "./PlanUsagePanel"

interface AccountViewProps {
  phone: string
  onSignOut: () => void
}

/** Mask a CN mainland phone into "138 **** 8000". */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-11)
  if (digits.length !== 11) return phone
  return `${digits.slice(0, 3)} **** ${digits.slice(7)}`
}

/** 2-letter badge from a model label, e.g. "Gemini 2.5 Pro" → "GE". */
function logoFor(label: string): string {
  const letters = (label.match(/[A-Za-z]/g) || []).join("")
  return (letters.slice(0, 2) || "AI").toUpperCase()
}

const fmtWhen = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    })
  } catch {
    return iso
  }
}

const AccountView: React.FC<AccountViewProps> = ({ phone, onSignOut }) => {
  const { t } = useTranslation()
  const [quota, setQuota] = useState<Quota | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [usage, setUsage] = useState<MeetingUsage[]>([])
  const [usageLoading, setUsageLoading] = useState(true)
  const [selectedUsage, setSelectedUsage] = useState<MeetingUsage | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const q = await window.electronAPI.getLlmQuota()
      setQuota(q)
    } catch (e: any) {
      setError(e?.message || t("account.planUsage.loadError"))
    } finally {
      setLoading(false)
    }
  }, [t])

  const loadUsage = useCallback(async () => {
    setUsageLoading(true)
    try {
      const [rows, meetings] = await Promise.all([
        window.electronAPI.getLlmUsage(),
        // Large limit so the title map covers the whole billing period, not just the recent 50.
        window.electronAPI.getRecentMeetings(500).catch(() => []),
      ])
      const titleById = new Map((meetings || []).map((m) => [m.id, m.title]))
      const mapped: MeetingUsage[] = (rows || [])
        // Skip usage tied to meetings that were never saved (discarded / too short): the
        // credits still count toward the quota, but there is no meeting to show.
        .filter((r) => titleById.has(r.meeting_id))
        .map((r) => ({
          id: r.meeting_id,
          meeting: titleById.get(r.meeting_id) || t("account.planUsage.untitledMeeting"),
          when: fmtWhen(r.last_used),
          kinds: r.kinds.map((k) => ({
            kind: k.kind,
            input: k.input_tokens,
            output: k.output_tokens,
            audioSeconds: k.audio_seconds,
            credits: k.credits,
            models: k.models.map((m) => ({
              logo: logoFor(m.label),
              org: "",
              model: m.label,
              input: m.input_tokens,
              output: m.output_tokens,
              audioSeconds: m.audio_seconds,
              rIn: m.rate_input,
              rOut: m.rate_output,
              rAudio: m.rate_audio,
              credits: m.credits,
            })),
          })),
        }))
      setUsage(mapped)
    } catch {
      setUsage([])
    } finally {
      setUsageLoading(false)
    }
  }, [t])

  useEffect(() => {
    load()
    loadUsage()
  }, [load, loadUsage])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-10 pt-10 pb-14">
        <header className="mb-7">
          <h1 className="text-2xl font-extrabold text-text-primary tracking-tight">{t("account.title")}</h1>
          <p className="text-sm text-text-secondary mt-1.5">{t("account.subtitle")}</p>
        </header>

        {/* Top row: Account card (left) + Usage Credit (right) */}
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)] items-stretch mb-4">
          {/* Account card */}
          <section className="rounded-2xl border border-border-subtle bg-bg-card shadow-sm p-6 flex flex-col">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-accent-secondary text-accent-primary flex items-center justify-center shrink-0">
                <User size={22} />
              </div>
              <div className="min-w-0">
                <div className="text-base font-bold text-text-primary tracking-tight">{maskPhone(phone)}</div>
                <div className="flex items-center gap-1.5 text-[12.5px] text-text-secondary mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  {t("account.verifiedViaSms")}
                </div>
              </div>
            </div>

            <div className="h-px bg-border-muted my-4" />

            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                {t("account.plan")}
              </span>
              <span className="text-[13px] font-semibold text-text-primary capitalize">{quota?.plan ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                {t("account.memberSince")}
              </span>
              <span className="text-[13px] font-semibold text-text-primary">{t("account.memberSinceValue")}</span>
            </div>

            <button
              type="button"
              onClick={() => void onSignOut()}
              className="mt-auto pt-5 w-full text-[13px] font-semibold text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center gap-2 rounded-xl"
            >
              <span className="w-full py-2.5 rounded-xl border border-border-muted flex items-center justify-center gap-2">
                <LogOut size={15} />
                {t("account.signOut")}
              </span>
            </button>
          </section>

          {/* Usage Credit card */}
          <UsageCreditCard quota={quota} loading={loading} error={error} onReload={load} />
        </div>

        {/* Full-width per-meeting usage log (or its per-model detail) */}
        {selectedUsage ? (
          <UsageDetailView usage={selectedUsage} onBack={() => setSelectedUsage(null)} />
        ) : (
          <UsageDetailsTable data={usage} loading={usageLoading} onSelect={setSelectedUsage} />
        )}
      </div>
    </div>
  )
}

export default AccountView
