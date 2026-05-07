'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, Building2, CalendarClock, Check, Copy, Loader2, MessageSquare, Send, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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

  const totalToDistribute = state.totalToDistribute
  const unitsCount = state.units.length
  const upcoming = state.dueDates.find((d) => d.date >= new Date().toISOString().slice(0, 10)) ?? state.dueDates[0]
  const primaryAccount = cashAccounts.find((a) => a.kind === 'bank' && a.isActive) ?? cashAccounts.find((a) => a.isActive) ?? cashAccounts[0]

  const blockReasons: string[] = []
  if (!canEmit) blockReasons.push('No tenés permisos para emitir liquidaciones.')
  if (!state.coverageOk) blockReasons.push(`Las alícuotas no suman 100% (suman ${(100 + state.coverageDeltaPct).toFixed(2)}%).`)
  if (totalToDistribute <= 0) blockReasons.push('No hay gastos cargados este mes.')
  if (state.runStatus === 'issued' || state.runStatus === 'closed') {
    blockReasons.push('La liquidación de este mes ya fue emitida.')
  }

  async function handleConfirm() {
    setSubmitting(true)
    try {
      const res = await emitAndNotify({
        propertyId,
        year,
        month,
        extraNote: extraNote.trim() || undefined,
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
        <DialogContent className="max-w-lg">
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
