import { Inbox } from 'lucide-react'
import { ComprobantesInbox, type ReceiptRow } from '@/components/admin-backoffice/consorcio/comprobantes-inbox'
import { requireIAdmin } from '@/lib/auth'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export default async function ComprobantesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ status?: 'pending' | 'approved' | 'rejected' | 'all' }>
}) {
  const { id } = await params
  const { status: statusParam } = await searchParams
  const status = statusParam ?? 'pending'

  await requireIAdmin({ capability: 'collections.view' })

  const supabase = await getSupabaseServerClient()
  if (!supabase) {
    return (
      <div className="glass-card rounded-2xl p-8 text-sm text-muted-foreground">
        Supabase no configurado.
      </div>
    )
  }

  let query = supabase
    .from('iadmin_payment_receipts')
    .select(
      `id, amount, paid_at, method, reference, receipt_path, status, review_notes, created_at,
       submitted_by_profile_id,
       profiles:submitted_by_profile_id (full_name),
       iadmin_liquidation_items!inner (
         id, unit_id, ordinary_amount, extraordinary_amount, previous_balance,
         iadmin_units!inner (code),
         iadmin_liquidation_runs!inner (id, managed_property_id, period_year, period_month)
       )`,
    )
    .eq('iadmin_liquidation_items.iadmin_liquidation_runs.managed_property_id', id)
    .order('created_at', { ascending: false })
    .limit(200)
  if (status !== 'all') {
    query = query.eq('status', status)
  }
  const { data: rows } = await query

  const receipts: ReceiptRow[] = (rows ?? []).map((r: any) => {
    const item = Array.isArray(r.iadmin_liquidation_items) ? r.iadmin_liquidation_items[0] : r.iadmin_liquidation_items
    const unit = item ? (Array.isArray(item.iadmin_units) ? item.iadmin_units[0] : item.iadmin_units) : null
    const run = item ? (Array.isArray(item.iadmin_liquidation_runs) ? item.iadmin_liquidation_runs[0] : item.iadmin_liquidation_runs) : null
    const profile = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
    const subtotal =
      Number(item?.ordinary_amount ?? 0) + Number(item?.extraordinary_amount ?? 0) + Number(item?.previous_balance ?? 0)
    return {
      id: r.id,
      amount: Number(r.amount),
      paidAt: r.paid_at,
      method: r.method ?? null,
      reference: r.reference ?? null,
      receiptPath: r.receipt_path ?? null,
      status: r.status,
      reviewNotes: r.review_notes ?? null,
      createdAt: r.created_at,
      submittedBy: profile?.full_name ?? '—',
      unitCode: unit?.code ?? '—',
      periodLabel: run ? `${String(run.period_month).padStart(2, '0')}/${run.period_year}` : '—',
      itemSubtotal: Math.round(subtotal * 100) / 100,
    }
  })

  return (
    <div className="space-y-6">
      <header className="glass-card rounded-2xl p-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
            <Inbox className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-primary font-medium">Bandeja</p>
            <h1 className="font-serif text-2xl font-bold text-foreground">Comprobantes de pago</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Aprobá los comprobantes que reportan los vecinos. Al aprobar, se registra el pago y baja el saldo de la unidad.
            </p>
          </div>
        </div>
      </header>

      <ComprobantesInbox receipts={receipts} consorcioId={id} currentStatus={status} />
    </div>
  )
}
