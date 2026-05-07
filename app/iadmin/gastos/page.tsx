import { ExpensesTable } from '@/components/admin-backoffice/gastos/expenses-table'
import { NewExpenseForm } from '@/components/admin-backoffice/gastos/new-expense-form'
import { ScopedToBuildingBanner } from '@/components/admin-backoffice/shell/scoped-to-building-banner'
import { can, requireIAdmin } from '@/lib/auth'
import { getIAdminExpensesInbox, getIAdminPortfolio, getIAdminProviders } from '@/lib/data'

export default async function GastosPage({
  searchParams,
}: {
  searchParams: Promise<{ propertyId?: string }>
}) {
  const { context } = await requireIAdmin({ capability: 'expenses.view' })

  const administrationId = context.primary?.administration.id
  if (!administrationId) {
    return (
      <div className="glass-card rounded-2xl p-8 text-sm text-muted-foreground">
        Tu cuenta no tiene una administracion asignada todavia.
      </div>
    )
  }

  const { propertyId } = await searchParams

  const [allExpenses, portfolio, providers] = await Promise.all([
    getIAdminExpensesInbox(administrationId),
    getIAdminPortfolio(administrationId),
    getIAdminProviders(administrationId),
  ])

  const expenses = propertyId
    ? allExpenses.filter((e) => e.managedPropertyId === propertyId)
    : allExpenses

  const scopedProperty = propertyId
    ? portfolio?.properties.find((p) => p.id === propertyId) ?? null
    : null

  const canCreate = can(context, 'expenses.create', { administrationId })

  return (
    <div className="space-y-6">
      <header className="glass-card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-wider text-primary font-medium">Bandeja de gastos</p>
        <h1 className="font-serif text-2xl font-bold text-foreground mt-1">
          {scopedProperty ? `Gastos · ${scopedProperty.displayName ?? scopedProperty.buildingName}` : 'Gastos a procesar'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {scopedProperty
            ? 'Mostrando solo los gastos de este edificio.'
            : 'Vista cross-cartera. Filtra y prioriza gastos pendientes de revision o validacion documental.'}
        </p>
      </header>

      {scopedProperty ? (
        <ScopedToBuildingBanner
          propertyName={scopedProperty.displayName ?? scopedProperty.buildingName}
          basePath="/iadmin/gastos"
        />
      ) : null}

      {canCreate && portfolio ? (
        <NewExpenseForm
          administrationId={administrationId}
          properties={portfolio.properties.map((p) => ({
            id: p.id,
            displayName: p.displayName,
            buildingName: p.buildingName,
          }))}
          providers={providers.map((p) => ({
            id: p.id,
            name: p.name,
            isActive: p.isActive,
            defaultCategory: p.defaultCategory,
            defaultDescription: p.defaultDescription,
          }))}
        />
      ) : null}

      <ExpensesTable expenses={expenses} />
    </div>
  )
}
