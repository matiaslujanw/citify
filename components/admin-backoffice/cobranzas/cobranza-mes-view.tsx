'use client'

import { useMemo, useState } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, MessageCircle, Phone, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Money } from '@/components/admin-backoffice/shared/money'
import type { IAdminLiquidationItem, IAdminLiquidationRunDetail } from '@/lib/types'

const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

type Bucket = 'paid_on_time' | 'paid_late' | 'partial' | 'unpaid'

type ItemRow = {
  item: IAdminLiquidationItem
  bucket: Bucket
  /** Fecha del último pago, si hay */
  lastPaidAt: string | null
  /** Monto que debería haber pagado en su vencimiento aplicable */
  expectedAmount: number
}

function classifyItem(item: IAdminLiquidationItem): ItemRow {
  // Usamos `item.dueAmounts` (los montos ya calculados con recargo por unidad).
  const sortedDues = [...item.dueAmounts].sort((a, b) => a.date.localeCompare(b.date))
  const firstDue = sortedDues[0] ?? null
  const lastDue = sortedDues[sortedDues.length - 1] ?? null
  const today = new Date().toISOString().slice(0, 10)

  // Último pago realizado por la unidad
  const sortedPayments = [...item.payments].sort((a, b) => b.paidAt.localeCompare(a.paidAt))
  const lastPaidAt = sortedPayments[0]?.paidAt?.slice(0, 10) ?? null

  // Monto esperado: el del vencimiento que aplica HOY (o el último si pasaron todos)
  const upcomingDue = sortedDues.find((d) => d.date >= today)
  const activeDue = upcomingDue ?? lastDue
  const expectedAmount = activeDue?.amount ?? item.subtotal

  // Si pagó >= subtotal base → categorizar según fecha
  if (item.collectedAmount >= item.subtotal - 0.01) {
    if (firstDue && lastPaidAt && lastPaidAt <= firstDue.date) {
      return { item, bucket: 'paid_on_time', lastPaidAt, expectedAmount }
    }
    return { item, bucket: 'paid_late', lastPaidAt, expectedAmount }
  }
  if (item.collectedAmount > 0.01) {
    return { item, bucket: 'partial', lastPaidAt, expectedAmount }
  }
  return { item, bucket: 'unpaid', lastPaidAt, expectedAmount }
}

function formatDateAR(iso: string | null) {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

const BUCKET_META: Record<Bucket, { label: string; icon: typeof CheckCircle2; tone: string; chip: string }> = {
  paid_on_time: {
    label: 'Pagó en tiempo',
    icon: CheckCircle2,
    tone: 'text-emerald-700 dark:text-emerald-400',
    chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  paid_late: {
    label: 'Pagó (tarde o con recargo)',
    icon: AlertTriangle,
    tone: 'text-amber-700 dark:text-amber-400',
    chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  partial: {
    label: 'Pago parcial',
    icon: AlertCircle,
    tone: 'text-orange-700 dark:text-orange-400',
    chip: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
  },
  unpaid: {
    label: 'Sin pagar',
    icon: AlertCircle,
    tone: 'text-rose-700 dark:text-rose-400',
    chip: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
  },
}

export function CobranzaMesView({ run }: { run: IAdminLiquidationRunDetail }) {
  const [search, setSearch] = useState('')
  const [openBucket, setOpenBucket] = useState<Bucket | 'all'>('all')

  const rows: ItemRow[] = useMemo(
    () => run.items.map((it) => classifyItem(it)),
    [run.items],
  )

  const stats = useMemo(() => {
    const acc = { paid_on_time: 0, paid_late: 0, partial: 0, unpaid: 0 }
    for (const r of rows) acc[r.bucket]++
    return acc
  }, [rows])

  const totals = useMemo(() => {
    const collected = run.items.reduce((s, it) => s + it.collectedAmount, 0)
    const owed = run.items.reduce((s, it) => s + it.balanceRemaining, 0)
    const expected = run.items.reduce((s, it) => s + it.subtotal, 0)
    return { collected, owed, expected, pct: expected > 0 ? (collected / expected) * 100 : 0 }
  }, [run.items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (openBucket !== 'all' && r.bucket !== openBucket) return false
      if (!q) return true
      return (
        r.item.unitCode.toLowerCase().includes(q) ||
        (r.item.activeHolderName ?? '').toLowerCase().includes(q)
      )
    })
  }, [rows, search, openBucket])

  const monthLabel = `${MONTHS_ES[run.periodMonth - 1]} ${run.periodYear}`

  return (
    <div className="space-y-4">
      {/* KPIs y resumen */}
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard
          label="Cobrado"
          value={<Money amount={totals.collected} />}
          hint={`${totals.pct.toFixed(0)}% del esperado`}
          tone="positive"
        />
        <KpiCard
          label="Pendiente"
          value={<Money amount={totals.owed} />}
          hint={`de ${formatARS(totals.expected)}`}
          tone={totals.owed > 0 ? 'negative' : 'neutral'}
        />
        <BucketKpi bucket="paid_on_time" count={stats.paid_on_time} />
        <BucketKpi bucket="paid_late" count={stats.paid_late} />
        <BucketKpi bucket="unpaid" count={stats.unpaid + stats.partial} label={`Sin pagar / parcial`} />
      </section>

      {/* Filtros */}
      <div className="glass-card rounded-2xl p-4 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar unidad o titular…"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {(['all', 'paid_on_time', 'paid_late', 'partial', 'unpaid'] as const).map((b) => {
            const isActive = openBucket === b
            const label = b === 'all' ? `Todos (${rows.length})` : `${BUCKET_META[b as Bucket].label} (${stats[b as Bucket]})`
            return (
              <button
                key={b}
                type="button"
                onClick={() => setOpenBucket(b)}
                className={[
                  'px-3 py-1.5 rounded-full text-xs transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground',
                ].join(' ')}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Lista */}
      <section className="glass-card rounded-2xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border/40 text-xs uppercase tracking-wider text-muted-foreground">
          Estado de cobranza · {monthLabel}
        </header>
        {filtered.length === 0 ? (
          <p className="px-5 py-10 text-sm text-muted-foreground text-center">No hay unidades para este filtro.</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {filtered.map((row) => <RowItem key={row.item.id} row={row} />)}
          </ul>
        )}
      </section>
    </div>
  )
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone: 'positive' | 'negative' | 'neutral'
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'negative'
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-muted-foreground'
  return (
    <div className="glass-card rounded-2xl p-4">
      <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">{label}</p>
      <p className={`font-serif text-xl font-bold tabular-nums mt-1 ${toneClass}`}>{value}</p>
      {hint ? <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p> : null}
    </div>
  )
}

function BucketKpi({ bucket, count, label }: { bucket: Bucket; count: number; label?: string }) {
  const meta = BUCKET_META[bucket]
  const Icon = meta.icon
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">{label ?? meta.label}</p>
        <Icon className={`w-4 h-4 ${meta.tone}`} />
      </div>
      <p className="font-serif text-xl font-bold text-foreground mt-1 tabular-nums">{count}</p>
    </div>
  )
}

function RowItem({ row }: { row: ItemRow }) {
  const meta = BUCKET_META[row.bucket]
  const [open, setOpen] = useState(false)
  const phone = (row.item.payments[0]?.method ?? '').replace(/[^\d+]/g, '') // placeholder
  const balance = row.item.balanceRemaining

  const reminderMessage = `Hola ${row.item.activeHolderName ?? 'vecino/a'}, te recuerdo que tenés un saldo pendiente de ${formatARS(balance)} en tu unidad ${row.item.unitCode}.`
  const waHref = `https://wa.me/?text=${encodeURIComponent(reminderMessage)}`

  return (
    <li className="px-5 py-3 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider ${meta.chip}`}>
          {meta.label}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            Unidad {row.item.unitCode}
            {row.item.activeHolderName ? <span className="text-muted-foreground font-normal"> · {row.item.activeHolderName}</span> : null}
          </p>
          <p className="text-xs text-muted-foreground">
            Total: <span className="tabular-nums"><Money amount={row.item.subtotal} /></span>
            {row.item.collectedAmount > 0 ? (
              <> · Cobrado: <span className="tabular-nums"><Money amount={row.item.collectedAmount} /></span></>
            ) : null}
            {balance > 0 ? (
              <> · <span className="text-rose-700 dark:text-rose-400">Debe: <span className="tabular-nums"><Money amount={balance} /></span></span></>
            ) : null}
            {row.lastPaidAt ? <> · Último pago: {formatDateAR(row.lastPaidAt)}</> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {balance > 0 ? (
            <a
              href={waHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 px-3 py-1.5 text-xs font-medium transition-colors"
              title="Recordar por WhatsApp"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              Recordar
            </a>
          ) : null}
          <Button size="icon" variant="ghost" onClick={() => setOpen((v) => !v)} className="h-8 w-8" title="Ver detalle">
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </div>
      {open ? (
        <div className="mt-3 ml-2 pl-4 border-l-2 border-border/40 space-y-1 text-xs text-muted-foreground">
          <p>Ordinaria: <span className="tabular-nums text-foreground"><Money amount={row.item.ordinaryAmount} /></span></p>
          {row.item.extraordinaryAmount > 0 ? (
            <p>Extraordinaria: <span className="tabular-nums text-foreground"><Money amount={row.item.extraordinaryAmount} /></span></p>
          ) : null}
          {row.item.previousBalance > 0 ? (
            <p>Saldo anterior: <span className="tabular-nums text-foreground"><Money amount={row.item.previousBalance} /></span></p>
          ) : null}
          {row.item.payments.length > 0 ? (
            <div className="pt-1">
              <p className="font-medium text-foreground">Pagos registrados:</p>
              <ul className="space-y-0.5">
                {row.item.payments.map((p) => (
                  <li key={p.id}>
                    {formatDateAR(p.paidAt.slice(0, 10))} · <Money amount={p.amount} /> {p.method ? `· ${p.method}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="italic">Todavía no se registraron pagos para esta unidad.</p>
          )}
        </div>
      ) : null}
    </li>
  )
}

function formatARS(n: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(n)
}
