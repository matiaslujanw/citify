'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  Loader2,
  Receipt,
  X,
  XCircle,
} from 'lucide-react'
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
import {
  approvePaymentReceipt,
  getReceiptSignedUrl,
  rejectPaymentReceipt,
} from '@/app/iadmin/consorcios/[id]/comprobantes/actions'

export type ReceiptRow = {
  id: string
  amount: number
  paidAt: string
  method: string | null
  reference: string | null
  receiptPath: string | null
  status: 'pending' | 'approved' | 'rejected'
  reviewNotes: string | null
  createdAt: string
  submittedBy: string
  unitCode: string
  periodLabel: string
  itemSubtotal: number
}

const STATUS_TABS: Array<{ key: 'pending' | 'approved' | 'rejected' | 'all'; label: string }> = [
  { key: 'pending', label: 'Pendientes' },
  { key: 'approved', label: 'Aprobados' },
  { key: 'rejected', label: 'Rechazados' },
  { key: 'all', label: 'Todos' },
]

export function ComprobantesInbox({
  receipts,
  consorcioId,
  currentStatus,
}: {
  receipts: ReceiptRow[]
  consorcioId: string
  currentStatus: 'pending' | 'approved' | 'rejected' | 'all'
}) {
  const router = useRouter()
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const [reviewReceipt, setReviewReceipt] = useState<ReceiptRow | null>(null)
  const [reviewMode, setReviewMode] = useState<'approve' | 'reject'>('approve')
  const [reviewNotes, setReviewNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [, startTransition] = useTransition()

  async function openPreview(r: ReceiptRow) {
    if (!r.receiptPath) {
      toast.info('Este comprobante no tiene archivo adjunto')
      return
    }
    setPreviewLoading(r.id)
    try {
      const { url } = await getReceiptSignedUrl(r.id)
      if (!url) throw new Error('No se pudo generar el link')
      setPreviewUrl(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cargar')
    } finally {
      setPreviewLoading(null)
    }
  }

  function openReview(r: ReceiptRow, mode: 'approve' | 'reject') {
    setReviewReceipt(r)
    setReviewMode(mode)
    setReviewNotes('')
  }

  async function handleConfirmReview() {
    if (!reviewReceipt) return
    setSubmitting(true)
    try {
      if (reviewMode === 'approve') {
        await approvePaymentReceipt({
          receiptId: reviewReceipt.id,
          reviewNotes: reviewNotes.trim() || undefined,
        })
        toast.success('Comprobante aprobado. Pago registrado.')
      } else {
        await rejectPaymentReceipt({
          receiptId: reviewReceipt.id,
          reviewNotes: reviewNotes.trim() || undefined,
        })
        toast.success('Comprobante rechazado.')
      }
      setReviewReceipt(null)
      startTransition(() => router.refresh())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo procesar')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <nav className="flex items-center gap-1 flex-wrap">
        {STATUS_TABS.map((tab) => {
          const isActive = tab.key === currentStatus
          const href = tab.key === 'pending' ? '?' : `?status=${tab.key}`
          return (
            <Link
              key={tab.key}
              href={href}
              scroll={false}
              className={[
                'px-3 py-1.5 rounded-full text-sm transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground font-medium'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground',
              ].join(' ')}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>

      {receipts.length === 0 ? (
        <div className="glass-card rounded-2xl p-10 text-center text-sm text-muted-foreground">
          No hay comprobantes en este filtro.
        </div>
      ) : (
        <ul className="glass-card rounded-2xl divide-y divide-border/40 overflow-hidden">
          {receipts.map((r) => (
            <li key={r.id} className="px-5 py-4 flex items-start gap-4 flex-wrap">
              <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Receipt className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-foreground">Unidad {r.unitCode}</span>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">{r.submittedBy}</span>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">Período {r.periodLabel}</span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="text-sm text-foreground">
                  <strong className="font-serif"><Money amount={r.amount} /></strong>
                  <span className="text-muted-foreground"> de {Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(r.itemSubtotal)}</span>
                  <span className="text-muted-foreground"> · pagó el {formatDateAR(r.paidAt)}</span>
                  {r.method ? <span className="text-muted-foreground"> · {r.method}</span> : null}
                  {r.reference ? <span className="text-muted-foreground"> · ref: {r.reference}</span> : null}
                </div>
                {r.reviewNotes ? (
                  <p className="text-xs text-muted-foreground italic">Nota: {r.reviewNotes}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {r.receiptPath ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void openPreview(r)}
                    disabled={previewLoading === r.id}
                  >
                    {previewLoading === r.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <Eye className="w-4 h-4 mr-1.5" />
                        Ver
                      </>
                    )}
                  </Button>
                ) : null}
                {r.status === 'pending' ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openReview(r, 'reject')}
                      title="Rechazar"
                    >
                      <XCircle className="w-4 h-4 text-rose-600" />
                    </Button>
                    <Button size="sm" onClick={() => openReview(r, 'approve')}>
                      <Check className="w-4 h-4 mr-1.5" />
                      Aprobar
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Preview del comprobante */}
      <Dialog open={!!previewUrl} onOpenChange={(v) => !v && setPreviewUrl(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Comprobante</DialogTitle>
          </DialogHeader>
          {previewUrl ? (
            <div className="space-y-2">
              {previewUrl.match(/\.pdf(\?|$)/i) ? (
                <iframe src={previewUrl} className="w-full h-[70vh] rounded-lg border border-border/40" />
              ) : (
                <img src={previewUrl} alt="Comprobante" className="w-full max-h-[70vh] object-contain rounded-lg border border-border/40" />
              )}
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                Abrir en nueva pestaña <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Modal de aprobar/rechazar con nota opcional */}
      <Dialog open={!!reviewReceipt} onOpenChange={(v) => !v && !submitting && setReviewReceipt(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {reviewMode === 'approve' ? 'Aprobar comprobante' : 'Rechazar comprobante'}
            </DialogTitle>
            <DialogDescription>
              {reviewReceipt ? (
                <>
                  Unidad {reviewReceipt.unitCode} · <Money amount={reviewReceipt.amount} /> · {reviewReceipt.method ?? 'sin método'}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {reviewMode === 'approve' ? (
              <p className="text-sm text-muted-foreground">
                Se va a registrar un pago real con este monto y el saldo de la unidad va a bajar.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                El vecino verá el rechazo y podrá volver a reportar el pago.
              </p>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Nota {reviewMode === 'reject' ? '(recomendada)' : '(opcional)'}</Label>
              <Input
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder={reviewMode === 'reject' ? 'Ej: el monto no coincide con el saldo' : 'Comentario interno o para el vecino'}
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setReviewReceipt(null)} disabled={submitting}>
                Cancelar
              </Button>
              <Button
                onClick={() => void handleConfirmReview()}
                disabled={submitting}
                variant={reviewMode === 'reject' ? 'destructive' : 'default'}
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : reviewMode === 'approve' ? (
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                ) : (
                  <X className="w-4 h-4 mr-2" />
                )}
                Confirmar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function StatusBadge({ status }: { status: 'pending' | 'approved' | 'rejected' }) {
  const map = {
    pending: { label: 'Pendiente', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
    approved: { label: 'Aprobado', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
    rejected: { label: 'Rechazado', cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-400' },
  } as const
  const m = map[status]
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${m.cls}`}>
      {m.label}
    </span>
  )
}

function formatDateAR(iso: string) {
  const date = iso.length >= 10 ? iso.slice(0, 10) : iso
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}
