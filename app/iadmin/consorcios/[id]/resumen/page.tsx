import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Inbox,
  ListChecks,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { Money } from '@/components/admin-backoffice/shared/money'
import { LiquidarButton } from '@/components/admin-backoffice/consorcio/liquidar-button'
import { can, requireIAdmin } from '@/lib/auth'
import { getIAdminCashAccounts, getIAdminMesaState, getIAdminMonthlyGrid } from '@/lib/data'

const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

export default async function ResumenPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { context } = await requireIAdmin({ capability: 'consorcio.view' })

  const grid = await getIAdminMonthlyGrid(id, { monthsCount: 1 })
  if (!grid) {
    return <EmptyConsorcio reason="No pudimos cargar los datos del consorcio." consorcioId={id} />
  }

  const currentMonth = grid.months[grid.months.length - 1]
  const [state, cashAccounts] = await Promise.all([
    getIAdminMesaState(id, currentMonth.year, currentMonth.month),
    getIAdminCashAccounts(id),
  ])
  if (!state) {
    return <EmptyConsorcio reason="Este consorcio todavía no tiene un período abierto." consorcioId={id} />
  }

  const canEmit = can(context, 'liquidations.create', { administrationId: grid.administrationId })

  const totalGastos = state.ordinaryTotal + state.extraordinaryTotal
  const saldo = state.totalCollected - totalGastos
  const pctCobrado = state.collectionRatePct ?? 0
  const monthLabel = `${MONTHS_ES[currentMonth.month - 1]} ${currentMonth.year}`

  const today = new Date().toISOString().slice(0, 10)
  const upcomingDue = state.dueDates.find((d) => d.date >= today) ?? state.dueDates[0]

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-primary font-medium">Mes en curso</p>
          <h2 className="font-serif text-2xl font-bold text-foreground mt-0.5">{monthLabel}</h2>
        </div>
        <LiquidarButton
          propertyId={id}
          year={currentMonth.year}
          month={currentMonth.month}
          monthLabel={monthLabel}
          state={state}
          cashAccounts={cashAccounts}
          canEmit={canEmit}
        />
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Ingresos cobrados"
          value={<Money amount={state.totalCollected} />}
          icon={TrendingUp}
          tone="positive"
          hint={`de ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(state.totalToDistribute)} a distribuir`}
        />
        <KpiCard
          label="Gastos del mes"
          value={<Money amount={totalGastos} />}
          icon={TrendingDown}
          tone="negative"
          hint={`Ord. ${formatShort(state.ordinaryTotal)} · Extra ${formatShort(state.extraordinaryTotal)}`}
        />
        <KpiCard
          label="Saldo"
          value={<Money amount={saldo} />}
          icon={Wallet}
          tone={saldo >= 0 ? 'positive' : 'negative'}
          hint={saldo >= 0 ? 'Ingresos superan gastos' : 'Gastos superan ingresos'}
        />
        <KpiCard
          label="Cobranza"
          value={<span className="tabular-nums">{pctCobrado.toFixed(0)}%</span>}
          icon={CheckCircle2}
          tone={pctCobrado >= 80 ? 'positive' : pctCobrado >= 50 ? 'neutral' : 'negative'}
          hint={`Pendiente ${formatShort(state.totalPending)}`}
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <BreakdownCard state={state} />
        <DueDatesCard upcomingDue={upcomingDue} dueDates={state.dueDates} />
        <StatusCard state={state} consorcioId={id} />
      </section>
    </div>
  )
}

function formatShort(n: number) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(n)
}

function KpiCard({
  label,
  value,
  icon: Icon,
  tone,
  hint,
}: {
  label: string
  value: React.ReactNode
  icon: typeof Wallet
  tone: 'positive' | 'negative' | 'neutral'
  hint?: string
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
      : tone === 'negative'
        ? 'text-rose-600 dark:text-rose-400 bg-rose-500/10'
        : 'text-amber-600 dark:text-amber-400 bg-amber-500/10'

  return (
    <div className="glass-card rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">{label}</p>
        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${toneClass}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <p className="font-serif text-2xl font-bold text-foreground mt-2">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground mt-1">{hint}</p> : null}
    </div>
  )
}

function BreakdownCard({ state }: { state: { ordinaryTotal: number; extraordinaryTotal: number; previousBalanceTotal: number } }) {
  const total = state.ordinaryTotal + state.extraordinaryTotal
  return (
    <div className="glass-card rounded-2xl p-5 space-y-3">
      <div className="flex items-center gap-2">
        <ListChecks className="w-4 h-4 text-muted-foreground" />
        <h3 className="font-medium text-sm text-foreground">Desglose de gastos</h3>
      </div>
      <ul className="space-y-2 text-sm">
        <BreakdownRow label="Ordinarios" amount={state.ordinaryTotal} />
        <BreakdownRow label="Extraordinarios" amount={state.extraordinaryTotal} />
        {state.previousBalanceTotal !== 0 ? (
          <BreakdownRow label="Saldo anterior" amount={state.previousBalanceTotal} muted />
        ) : null}
      </ul>
      <div className="border-t border-border/40 pt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Total</span>
        <strong className="font-serif text-base"><Money amount={total} /></strong>
      </div>
    </div>
  )
}

function BreakdownRow({ label, amount, muted }: { label: string; amount: number; muted?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className={muted ? 'text-muted-foreground' : 'text-foreground'}>{label}</span>
      <span className="tabular-nums text-foreground"><Money amount={amount} /></span>
    </li>
  )
}

function DueDatesCard({
  upcomingDue,
  dueDates,
}: {
  upcomingDue: { label: string; date: string; surchargePct: number } | undefined
  dueDates: Array<{ label: string; date: string; surchargePct: number }>
}) {
  return (
    <div className="glass-card rounded-2xl p-5 space-y-3">
      <div className="flex items-center gap-2">
        <CalendarClock className="w-4 h-4 text-muted-foreground" />
        <h3 className="font-medium text-sm text-foreground">Vencimientos</h3>
      </div>
      {upcomingDue ? (
        <div>
          <p className="text-xs text-muted-foreground">Próximo</p>
          <p className="font-serif text-lg font-semibold text-foreground">
            {formatDateAR(upcomingDue.date)}
          </p>
          <p className="text-xs text-muted-foreground">{upcomingDue.label}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Sin vencimientos cargados.</p>
      )}
      {dueDates.length > 1 ? (
        <ul className="text-xs text-muted-foreground space-y-1 pt-2 border-t border-border/40">
          {dueDates.map((d) => (
            <li key={d.label} className="flex items-center justify-between">
              <span>{d.label}</span>
              <span>{formatDateAR(d.date)}{d.surchargePct ? ` · +${d.surchargePct}%` : ''}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function StatusCard({
  state,
  consorcioId,
}: {
  state: { hasRun: boolean; runStatus: string | null; coverageOk: boolean; coverageDeltaPct: number }
  consorcioId: string
}) {
  const items: Array<{ ok: boolean; label: string }> = [
    { ok: state.coverageOk, label: state.coverageOk ? 'Alícuotas suman 100%' : `Alícuotas: ${(100 + state.coverageDeltaPct).toFixed(2)}%` },
    { ok: state.hasRun, label: state.hasRun ? `Liquidación generada (${state.runStatus ?? '—'})` : 'Liquidación pendiente' },
  ]
  return (
    <div className="glass-card rounded-2xl p-5 space-y-3">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 text-muted-foreground" />
        <h3 className="font-medium text-sm text-foreground">Estado</h3>
      </div>
      <ul className="space-y-2 text-sm">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2">
            {it.ok ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            )}
            <span className={it.ok ? 'text-foreground' : 'text-muted-foreground'}>{it.label}</span>
          </li>
        ))}
      </ul>
      <Link
        href={`/iadmin/consorcios/${consorcioId}/movimientos`}
        className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline pt-1"
      >
        Ir a movimientos
        <ArrowRight className="w-3 h-3" />
      </Link>
    </div>
  )
}

function formatDateAR(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

function EmptyConsorcio({ reason, consorcioId }: { reason: string; consorcioId: string }) {
  return (
    <div className="glass-card rounded-2xl p-10 text-center space-y-3">
      <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
        <Inbox className="w-6 h-6 text-primary" />
      </div>
      <h2 className="font-serif text-xl font-bold text-foreground">Sin datos para mostrar</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">{reason}</p>
      <div className="flex items-center justify-center gap-3 pt-2">
        <Link
          href={`/iadmin/consorcios/${consorcioId}/movimientos`}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Ir a movimientos
          <ArrowRight className="w-4 h-4" />
        </Link>
        <Link
          href={`/iadmin/consorcios/${consorcioId}/configuracion`}
          className="inline-flex items-center gap-2 rounded-full border border-border/50 px-4 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
        >
          Configuración
        </Link>
      </div>
    </div>
  )
}
