'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, Loader2, Paperclip, ReceiptText, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Money } from '@/components/admin-backoffice/shared/money'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import { submitPaymentReceipt } from '@/app/propietario/actions'
import type { IAdminLiquidationItemDueAmount } from '@/lib/types'

const BUCKET = 'iadmin-payment-receipts'
const MAX_MB = 10

type Props = {
  liquidationItemId: string
  unitCode: string
  balanceRemaining: number
  subtotal?: number
  dueAmounts?: IAdminLiquidationItemDueAmount[]
  trigger?: React.ReactNode
}

type ResolvedDue = {
  /** Vencimiento que aplica al pagar HOY (label, fecha, monto sugerido). */
  active: IAdminLiquidationItemDueAmount | null
  /** Recargo % aplicado en el vencimiento activo. */
  surchargePct: number
  /** Si pasó al menos un vencimiento sin pagar (estado "tarde"). */
  isLate: boolean
  /** Si todos los vencimientos ya pasaron. */
  allOverdue: boolean
}

function resolveActiveDue(dueAmounts: IAdminLiquidationItemDueAmount[] | undefined, today: string): ResolvedDue {
  if (!dueAmounts || dueAmounts.length === 0) {
    return { active: null, surchargePct: 0, isLate: false, allOverdue: false }
  }
  const sorted = [...dueAmounts].sort((a, b) => a.date.localeCompare(b.date))
  // El vencimiento "vigente" es el primero cuya fecha aún no pasó.
  // Si todos pasaron, usamos el último (con su recargo).
  const upcoming = sorted.find((d) => d.date >= today)
  const active = upcoming ?? sorted[sorted.length - 1]
  const isLate = !upcoming || active !== sorted[0]
  const allOverdue = !upcoming
  return { active, surchargePct: active?.surchargePct ?? 0, isLate, allOverdue }
}

function randomId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function sanitize(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120)
}

export function ReportPaymentDialog({
  liquidationItemId,
  unitCode,
  balanceRemaining,
  subtotal,
  dueAmounts,
  trigger,
}: Props) {
  const router = useRouter()
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const resolved = useMemo(() => resolveActiveDue(dueAmounts, today), [dueAmounts, today])

  // Si tenemos subtotal + un recargo activo, calculamos el monto sugerido.
  // Si no, caemos al saldo pendiente como antes.
  const suggestedAmount = useMemo(() => {
    if (resolved.active) return resolved.active.amount
    if (typeof subtotal === 'number' && subtotal > 0) return subtotal
    return balanceRemaining
  }, [resolved.active, subtotal, balanceRemaining])

  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [amount, setAmount] = useState(suggestedAmount > 0 ? String(suggestedAmount) : '')
  const [paidAt, setPaidAt] = useState(today)
  const [method, setMethod] = useState<'transferencia' | 'efectivo' | 'mercadopago' | 'otro'>('transferencia')
  const [reference, setReference] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  function reset() {
    setAmount(suggestedAmount > 0 ? String(suggestedAmount) : '')
    setPaidAt(today)
    setMethod('transferencia')
    setReference('')
    setFile(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const parsedAmount = Number(amount.trim().replace(/\./g, '').replace(',', '.'))
    if (!parsedAmount || parsedAmount <= 0) {
      toast.error('Monto inválido')
      return
    }
    if (file && file.size > MAX_MB * 1024 * 1024) {
      toast.error(`El archivo supera ${MAX_MB}MB`)
      return
    }

    setSubmitting(true)
    try {
      let receiptPath: string | undefined
      if (file) {
        const supabase = getSupabaseBrowserClient()
        if (!supabase) throw new Error('Supabase no configurado')
        const path = `${liquidationItemId}/${randomId()}-${sanitize(file.name)}`
        const { error: uploadErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, file, {
            cacheControl: '3600',
            upsert: false,
            contentType: file.type || 'application/octet-stream',
          })
        if (uploadErr) throw new Error(uploadErr.message)
        receiptPath = path
      }

      await submitPaymentReceipt({
        liquidationItemId,
        amount: parsedAmount,
        paidAt,
        method,
        reference: reference.trim() || undefined,
        receiptPath,
      })

      toast.success('Comprobante enviado. El admin lo va a revisar.')
      setOpen(false)
      reset()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo enviar')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="contents"
      >
        {trigger ?? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            <ReceiptText className="w-3.5 h-3.5" />
            Reportar pago
          </span>
        )}
      </button>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reportar un pago</DialogTitle>
          <DialogDescription>
            Unidad {unitCode} · Saldo: <Money amount={balanceRemaining} />. El comprobante queda en revisión hasta que el admin lo apruebe.
          </DialogDescription>
        </DialogHeader>

        <DueDateBanner resolved={resolved} subtotal={subtotal} />

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Monto</Label>
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                required
                className="text-right tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Fecha de pago</Label>
              <Input
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Método</Label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="transferencia">Transferencia</option>
              <option value="mercadopago">Mercado Pago</option>
              <option value="efectivo">Efectivo</option>
              <option value="otro">Otro</option>
            </select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Referencia (opcional)</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="N° de operación, alias, etc."
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Comprobante (opcional)</Label>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="w-full inline-flex items-center justify-between gap-2 rounded-md border border-dashed border-border/60 px-3 py-2 text-sm text-muted-foreground hover:border-primary/40 hover:bg-muted/30 transition-colors"
            >
              <span className="inline-flex items-center gap-2 truncate">
                <Paperclip className="w-4 h-4 shrink-0" />
                {file ? file.name : 'Adjuntar imagen o PDF'}
              </span>
              {!file ? <Upload className="w-4 h-4" /> : null}
            </button>
            {file ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline"
                onClick={() => setFile(null)}
              >
                Quitar archivo
              </button>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Enviando…
                </>
              ) : (
                'Enviar comprobante'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DueDateBanner({
  resolved,
  subtotal,
}: {
  resolved: ResolvedDue
  subtotal?: number
}) {
  const { active, surchargePct, isLate, allOverdue } = resolved
  if (!active) return null

  const dateLabel = formatDateAR(active.date)
  const surchargeAmount = typeof subtotal === 'number' && surchargePct > 0
    ? active.amount - subtotal
    : 0

  // 3 estados visuales:
  //   - en término (1er venc, sin recargo) → verde
  //   - tarde con recargo (estás dentro de un venc posterior) → ámbar
  //   - vencidos todos → rojo
  if (allOverdue) {
    return (
      <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-3 text-sm space-y-1">
        <div className="flex items-center gap-2 text-rose-700 dark:text-rose-400 font-medium">
          <AlertTriangle className="w-4 h-4" />
          Pasaste todos los vencimientos
        </div>
        <p className="text-xs text-rose-700/90 dark:text-rose-400/90">
          El monto sugerido incluye el recargo del último vencimiento ({dateLabel} · +{surchargePct}%):{' '}
          <strong className="tabular-nums"><Money amount={active.amount} /></strong>.
        </p>
      </div>
    )
  }
  if (isLate && surchargePct > 0) {
    return (
      <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 text-sm space-y-1">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-medium">
          <AlertTriangle className="w-4 h-4" />
          Estás pagando con +{surchargePct}% de recargo
        </div>
        <p className="text-xs text-amber-700/90 dark:text-amber-400/90">
          Pasaste el primer vencimiento. Próximo: {dateLabel}. Total a pagar:{' '}
          <strong className="tabular-nums"><Money amount={active.amount} /></strong>
          {surchargeAmount > 0 ? (
            <> (recargo: <span className="tabular-nums"><Money amount={surchargeAmount} /></span>)</>
          ) : null}
          .
        </p>
      </div>
    )
  }
  return (
    <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 text-sm space-y-1">
      <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-medium">
        <CheckCircle2 className="w-4 h-4" />
        Pagás dentro del primer vencimiento
      </div>
      <p className="text-xs text-emerald-700/90 dark:text-emerald-400/90">
        Vencimiento: {dateLabel}. Total a pagar:{' '}
        <strong className="tabular-nums"><Money amount={active.amount} /></strong>. Sin recargos.
      </p>
    </div>
  )
}

function formatDateAR(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}
