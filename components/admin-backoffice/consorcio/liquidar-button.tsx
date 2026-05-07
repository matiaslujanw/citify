'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, Building2, CalendarClock, Check, Copy, Loader2, MessageSquare, Plus, Send, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Money } from '@/components/admin-backoffice/shared/money'
import { PublishDialog } from '@/components/admin-backoffice/consorcio/publish-dialog'
import { emitAndNotify, type EmitAndNotifyResult } from '@/app/iadmin/consorcios/[id]/planilla/actions'
import type { IAdminCashAccount, IAdminMesaState } from '@/lib/types'

type Props = {
  propertyId: string
  year: number
  month: number
  monthLabel: string
  state: IAdminMesaState
  cashAccounts: IAdminCashAccount[]
  canEmit: boolean
}

export function LiquidarButton({
  propertyId,
  year,
  month,
  monthLabel,
  state,
  cashAccounts,
  canEmit,
}: Props) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<EmitAndNotifyResult | null>(null)
  const [extraNote, setExtraNote] = useState('')

  type DueDateRow = { label: string; date: string; surchargePct: number }
  const initialDueDates: DueDateRow[] = state.dueDates.length > 0
    ? state.dueDates.map((d) => ({ label: d.label, date: d.date, surchargePct: d.surchargePct }))
    : [
        { label: '1er vencimiento', date: defaultDueDate(year, month, 10), surchargePct: 0 },
        { label: '2do vencimiento', date: defaultDueDate(year, month, 25), surchargePct: 3 },
      ]
  const [dueDates, setDueDates] = useState<DueDateRow[]>(initialDueDates)

  // Si cambian los dueDates del state (al refrescar) sincronizamos el form
  // mientras el modal esté cerrado, sin pisar lo que el admin esté editando.
  useEffect(() => {
    if (open) return
    setDueDates(initialDueDates)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.dueDates.map((d) => `${d.date}|${d.surchargePct}`).join(',')])

  const totalToDistribute = state.totalToDistribute
  const unitsCount = state.units.length
  const primaryAccount = cashAccounts.find((a) => a.kind === 'bank' && a.isActive) ?? cashAccounts.find((a) => a.isActive) ?? cashAccounts[0]

  const sortedDueDates = [...dueDates].sort((a, b) => a.date.localeCompare(b.date))
  const upcoming = sortedDueDates.find((d) => d.date >= new Date().toISOString().slice(0, 10)) ?? sortedDueDates[0]

  const blockReasons: string[] = []
  if (!canEmit) blockReasons.push('No tenés permisos para emitir liquidaciones.')
  if (!state.coverageOk) blockReasons.push(`Las alícuotas no suman 100% (suman ${(100 + state.coverageDeltaPct).toFixed(2)}%).`)
  if (totalToDistribute <= 0) blockReasons.push('No hay gastos cargados este mes.')
  if (state.runStatus === 'issued' || state.runStatus === 'closed') {
    blockReasons.push('La liquidación de este mes ya fue emitida.')
  }
  if (dueDates.length === 0) {
    blockReasons.push('Cargá al menos 1 vencimiento.')
  }
  if (dueDates.some((d) => !d.label.trim())) {
    blockReasons.push('Cada vencimiento necesita un nombre.')
  }
  if (dueDates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d.date))) {
    blockReasons.push('Las fechas de vencimiento son inválidas.')
  }
  if (dueDates.some((d) => d.surchargePct < 0 || d.surchargePct > 100)) {
    blockReasons.push('El recargo debe estar entre 0 y 100%.')
  }
  // Avisar si el primer venc. NO tiene recargo 0 (caso raro pero valido).
  if (sortedDueDates[0] && sortedDueDates[0].surchargePct > 0) {
    // No es bloqueante, sólo informativo. No lo agregamos a blockReasons.
  }

  function updateDue(idx: number, patch: Partial<DueDateRow>) {
    setDueDates((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }
  function addDue() {
    if (dueDates.length >= 4) {
      toast.info('Máximo 4 vencimientos.')
      return
    }
    const lastDate = sortedDueDates[sortedDueDates.length - 1]?.date ?? defaultDueDate(year, month, 10)
    const next = addDays(lastDate, 10)
    setDueDates((prev) => [
      ...prev,
      { label: `${prev.length + 1}° vencimiento`, date: next, surchargePct: (prev[prev.length - 1]?.surchargePct ?? 0) + 3 },
    ])
  }
  function removeDue(idx: number) {
    if (dueDates.length <= 1) {
      toast.info('Tiene que haber al menos 1 vencimiento.')
      return
    }
    setDueDates((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleConfirm() {
    setSubmitting(true)
    try {
      const res = await emitAndNotify({
        propertyId,
        year,
        month,
        extraNote: extraNote.trim() || undefined,
        dueDates: dueDates.map((d) => ({
          label: d.label.trim(),
          date: d.date,
          surchargePct: d.surchargePct,
        })),
      })
      setResult(res)
      setOpen(false)
      toast.success(`Liquidación emitida. ${res.liquidated} unidades.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo emitir')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button
        size="lg"
        onClick={() => setOpen(true)}
        className="rounded-full shadow-sm"
      >
        <Send className="w-4 h-4 mr-2" />
        Liquidar y enviar
      </Button>

      <Dialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Liquidar y enviar — {monthLabel}</DialogTitle>
            <DialogDescription>
              Antes de emitir, revisá el resumen. Se generarán las expensas para cada unidad y vas a poder enviarlas por WhatsApp.
            </DialogDescription>
          </DialogHeader>

          {blockReasons.length > 0 ? (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 space-y-1.5">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-medium text-sm">
                <AlertTriangle className="w-4 h-4" />
                Falta resolver
              </div>
              <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc pl-5 space-y-0.5">
                {blockReasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
          ) : null}

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Field icon={Building2} label="Total a distribuir" value={<Money amount={totalToDistribute} />} />
            <Field icon={Users} label="Unidades" value={<span>{unitsCount}</span>} />
            <Field
              icon={CalendarClock}
              label="Próximo vencimiento"
              value={<span>{upcoming ? formatDateAR(upcoming.date) : '—'}</span>}
            />
            <Field
              icon={Check}
              label="Ord. / Extra"
              value={<span className="text-xs">{formatShort(state.ordinaryTotal)} · {formatShort(state.extraordinaryTotal)}</span>}
            />
          </dl>

          <div className="rounded-lg border border-border/40 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium inline-flex items-center gap-1.5">
                <CalendarClock className="w-3 h-3" />
                Vencimientos
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={addDue}
                disabled={submitting || dueDates.length >= 4}
                className="h-7 text-xs"
              >
                <Plus className="w-3 h-3 mr-1" />
                Agregar
              </Button>
            </div>
            <div className="space-y-3">
              {dueDates.map((d, idx) => {
                const exampleUnitAvg = unitsCount > 0 ? totalToDistribute / unitsCount : 0
                const exampleWithSurcharge = exampleUnitAvg * (1 + d.surchargePct / 100)
                const exampleSurchargeAmount = exampleWithSurcharge - exampleUnitAvg
                return (
                  <div key={idx} className="rounded-md border border-border/30 bg-muted/10 p-2.5 space-y-2">
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-4 space-y-1">
                        {idx === 0 && <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Etiqueta</Label>}
                        <Input
                          value={d.label}
                          onChange={(e) => updateDue(idx, { label: e.target.value })}
                          placeholder={`${idx + 1}° venc`}
                          disabled={submitting}
                          className="h-9 text-sm"
                        />
                      </div>
                      <div className="col-span-4 space-y-1">
                        {idx === 0 && <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Fecha</Label>}
                        <Input
                          type="date"
                          value={d.date}
                          onChange={(e) => updateDue(idx, { date: e.target.value })}
                          disabled={submitting}
                          className="h-9 text-sm"
                        />
                      </div>
                      <div className="col-span-3 space-y-1">
                        {idx === 0 && <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Recargo %</Label>}
                        <div className="relative">
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step="0.5"
                            value={d.surchargePct}
                            onChange={(e) => updateDue(idx, { surchargePct: Number(e.target.value) || 0 })}
                            disabled={submitting}
                            className="h-9 text-sm text-right pr-6 tabular-nums"
                          />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">%</span>
                        </div>
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removeDue(idx)}
                          disabled={submitting || dueDates.length <= 1}
                          className="h-9 w-9"
                          title="Quitar"
                        >
                          <Trash2 className="w-4 h-4 text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                    {totalToDistribute > 0 && unitsCount > 0 ? (
                      <div className="flex items-center justify-between gap-2 text-[11px] px-1">
                        <span className="text-muted-foreground">
                          {d.surchargePct > 0 ? (
                            <>
                              Si paga acá: <span className="text-amber-700 dark:text-amber-400 font-medium">+{d.surchargePct}%</span>
                              <span className="text-muted-foreground/70"> sobre el monto de cada unidad</span>
                            </>
                          ) : (
                            <span className="text-emerald-700 dark:text-emerald-400">✓ Sin recargo</span>
                          )}
                        </span>
                        <span className="text-muted-foreground">
                          Ej. unidad de <span className="tabular-nums"><Money amount={exampleUnitAvg} /></span> paga{' '}
                          <span className="font-medium text-foreground tabular-nums"><Money amount={exampleWithSurcharge} /></span>
                          {d.surchargePct > 0 ? (
                            <span className="text-amber-700 dark:text-amber-400"> (+<span className="tabular-nums"><Money amount={exampleSurchargeAmount} /></span>)</span>
                          ) : null}
                        </span>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
            <div className="rounded-md bg-blue-500/5 border border-blue-500/20 p-2 text-[10px] text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Cómo funciona:</strong> el recargo se aplica <strong>por unidad</strong>, no
              sobre el total. Cada vecino paga lo suyo según la fecha en la que pague. Los que pagan en el primer
              vencimiento se zafan del recargo aunque otros paguen tarde.
            </div>
          </div>

          {primaryAccount ? (
            <div className="rounded-lg border border-border/40 p-3 space-y-2 bg-muted/20">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Cuenta para depositar</p>
                <Link
                  href={`/iadmin/consorcios/${propertyId}/cuentas`}
                  className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                >
                  Editar cuentas <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
              <p className="font-medium text-sm">{primaryAccount.name}{primaryAccount.bankName ? ` · ${primaryAccount.bankName}` : ''}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {primaryAccount.alias ? (
                  <CopyRow label="Alias" value={primaryAccount.alias} />
                ) : null}
                {primaryAccount.cbu ? (
                  <CopyRow label="CBU" value={primaryAccount.cbu} />
                ) : null}
              </div>
              {!primaryAccount.alias && !primaryAccount.cbu ? (
                <Link
                  href={`/iadmin/consorcios/${propertyId}/cuentas`}
                  className="block text-xs text-amber-700 dark:text-amber-400 hover:underline"
                >
                  Cargá CBU/alias en Configuración → Cuentas para que aparezcan en el aviso.
                </Link>
              ) : null}
            </div>
          ) : (
            <Link
              href={`/iadmin/consorcios/${propertyId}/cuentas`}
              className="block rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
            >
              No hay cuentas bancarias cargadas. Cargá una en Configuración → Cuentas para que el vecino sepa dónde depositar.
            </Link>
          )}

          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <MessageSquare className="w-3 h-3" />
              Nota para los vecinos (opcional)
            </Label>
            <Textarea
              value={extraNote}
              onChange={(e) => setExtraNote(e.target.value.slice(0, 280))}
              placeholder="Ej: A partir del próximo mes vamos a cambiar de día de pago, o se realiza el aumento del encargado…"
              rows={2}
              className="text-sm resize-none"
            />
            <p className="text-[10px] text-muted-foreground text-right">
              {extraNote.length}/280 — se agrega al final del mensaje de WhatsApp
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleConfirm} disabled={submitting || blockReasons.length > 0}>
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Emitiendo…
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Confirmar y emitir
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {result ? <PublishDialog result={result} onClose={() => setResult(null)} /> : null}
    </>
  )
}

function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Building2
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="font-medium text-sm text-foreground">{value}</p>
      </div>
    </div>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value)
        toast.success(`${label} copiado`)
      }}
      className="flex items-center justify-between gap-2 rounded border border-border/40 px-2 py-1.5 hover:border-primary/40 hover:bg-background transition-colors text-left"
    >
      <span>
        <span className="text-muted-foreground">{label}: </span>
        <span className="font-mono text-foreground">{value}</span>
      </span>
      <Copy className="w-3 h-3 text-muted-foreground shrink-0" />
    </button>
  )
}

function formatShort(n: number) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(n)
}

function formatDateAR(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

// Devuelve YYYY-MM-DD para el día `day` del mes siguiente al período.
function defaultDueDate(periodYear: number, periodMonth: number, day: number): string {
  const nextMonth = periodMonth === 12 ? 1 : periodMonth + 1
  const nextYear = periodMonth === 12 ? periodYear + 1 : periodYear
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  const yy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}
