import { ScopedToBuildingBanner } from '@/components/admin-backoffice/shell/scoped-to-building-banner'
import { CobranzaMesView } from '@/components/admin-backoffice/cobranzas/cobranza-mes-view'
import { requireIAdmin } from '@/lib/auth'
import { getIAdminLiquidationRunDetail, getIAdminPortfolio } from '@/lib/data'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export default async function CobranzasPage({
  searchParams,
}: {
  searchParams: Promise<{ propertyId?: string }>
}) {
  const { context } = await requireIAdmin({ capability: 'collections.view' })

  const { propertyId } = await searchParams
  const administrationId = context.primary?.administration.id
  const portfolio = administrationId ? await getIAdminPortfolio(administrationId) : null
  const scopedProperty = propertyId
    ? portfolio?.properties.find((p) => p.id === propertyId) ?? null
    : null

  // Si está scopeado a un edificio, traemos el último run emitido / cerrado
  // para mostrar el estado de cobranza del mes en curso.
  let runDetail: Awaited<ReturnType<typeof getIAdminLiquidationRunDetail>> = null
  if (scopedProperty) {
    const supabase = await getSupabaseServerClient()
    if (supabase) {
      const { data: latestRun } = await supabase
        .from('iadmin_liquidation_runs')
        .select('id')
        .eq('managed_property_id', scopedProperty.id)
        .in('status', ['issued', 'closed'])
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (latestRun?.id) {
        runDetail = await getIAdminLiquidationRunDetail(latestRun.id as string)
      }
    }
  }

  return (
    <div className="space-y-4">
      <header className="glass-card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-wider text-primary font-medium">Cobranzas</p>
        <h1 className="font-serif text-2xl font-bold text-foreground mt-1">
          {scopedProperty ? `Cobranzas · ${scopedProperty.displayName ?? scopedProperty.buildingName}` : 'Cobranzas y deuda'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {scopedProperty
            ? 'Estado de cobranza del último mes emitido. Quién pagó, quién pagó tarde, quién está en deuda.'
            : 'Conciliacion de pagos contra liquidaciones emitidas.'}
        </p>
      </header>
      {scopedProperty ? (
        <ScopedToBuildingBanner
          propertyName={scopedProperty.displayName ?? scopedProperty.buildingName}
          basePath="/iadmin/cobranzas"
        />
      ) : null}

      {scopedProperty ? (
        runDetail ? (
          <CobranzaMesView run={runDetail} />
        ) : (
          <div className="glass-card rounded-2xl p-8 text-sm text-muted-foreground text-center">
            Este edificio todavía no tiene una liquidación emitida. Andá a Resumen → "Liquidar y enviar" para emitir la del mes.
          </div>
        )
      ) : (
        <div className="glass-card rounded-2xl p-8 text-sm text-muted-foreground">
          Vista cross-cartera de cobranzas en desarrollo. Por ahora, entrá a un edificio para ver su estado de cobranza del mes.
        </div>
      )}
    </div>
  )
}
