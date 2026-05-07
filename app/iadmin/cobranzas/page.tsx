import { ScopedToBuildingBanner } from '@/components/admin-backoffice/shell/scoped-to-building-banner'
import { requireIAdmin } from '@/lib/auth'
import { getIAdminPortfolio } from '@/lib/data'

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

  return (
    <div className="space-y-4">
      <header className="glass-card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-wider text-primary font-medium">Cobranzas</p>
        <h1 className="font-serif text-2xl font-bold text-foreground mt-1">
          {scopedProperty ? `Cobranzas · ${scopedProperty.displayName ?? scopedProperty.buildingName}` : 'Cobranzas y deuda'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Conciliacion de pagos contra liquidaciones emitidas.
        </p>
      </header>
      {scopedProperty ? (
        <ScopedToBuildingBanner
          propertyName={scopedProperty.displayName ?? scopedProperty.buildingName}
          basePath="/iadmin/cobranzas"
        />
      ) : null}
      <div className="glass-card rounded-2xl p-8 text-sm text-muted-foreground">
        El modulo de cobranzas esta modelado (iadmin_payments + iadmin_bank_movements) y se desarrolla en la fase 4.
      </div>
    </div>
  )
}
