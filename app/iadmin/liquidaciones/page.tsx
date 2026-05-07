import { LiquidationsTable } from '@/components/admin-backoffice/liquidaciones/liquidations-table'
import { ScopedToBuildingBanner } from '@/components/admin-backoffice/shell/scoped-to-building-banner'
import { requireIAdmin } from '@/lib/auth'
import { getIAdminLiquidationRuns, getIAdminPortfolio } from '@/lib/data'

export default async function LiquidacionesPage({
  searchParams,
}: {
  searchParams: Promise<{ propertyId?: string }>
}) {
  const { context } = await requireIAdmin({ capability: 'liquidations.view' })

  const administrationId = context.primary?.administration.id
  const { propertyId } = await searchParams

  const [allRuns, portfolio] = administrationId
    ? await Promise.all([
        getIAdminLiquidationRuns(administrationId),
        getIAdminPortfolio(administrationId),
      ])
    : [[], null]

  const runs = propertyId ? allRuns.filter((r) => r.managedPropertyId === propertyId) : allRuns
  const scopedProperty = propertyId
    ? portfolio?.properties.find((p) => p.id === propertyId) ?? null
    : null

  return (
    <div className="space-y-6">
      <header className="glass-card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-wider text-primary font-medium">Liquidaciones</p>
        <h1 className="font-serif text-2xl font-bold text-foreground mt-1">
          {scopedProperty ? `Liquidaciones · ${scopedProperty.displayName ?? scopedProperty.buildingName}` : 'Corridas mensuales'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {scopedProperty
            ? 'Liquidaciones emitidas para este edificio.'
            : 'Cada corrida se genera por consorcio + periodo contable y consume los gastos imputados.'}
        </p>
      </header>

      {scopedProperty ? (
        <ScopedToBuildingBanner
          propertyName={scopedProperty.displayName ?? scopedProperty.buildingName}
          basePath="/iadmin/liquidaciones"
        />
      ) : null}

      <LiquidationsTable runs={runs} />
    </div>
  )
}
