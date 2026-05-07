import { RemindersInbox } from '@/components/admin-backoffice/recordatorios/reminders-inbox'
import { ScopedToBuildingBanner } from '@/components/admin-backoffice/shell/scoped-to-building-banner'
import { requireIAdmin } from '@/lib/auth'
import { getIAdminPortfolio, getIAdminReminders } from '@/lib/data'

export default async function RecordatoriosPage({
  searchParams,
}: {
  searchParams: Promise<{ propertyId?: string }>
}) {
  const { context } = await requireIAdmin({ capability: 'reminders.generate' })

  const administrationId = context.primary?.administration.id
  if (!administrationId) {
    return (
      <div className="glass-card rounded-2xl p-8 text-sm text-muted-foreground">
        Tu cuenta no tiene una administracion asignada todavia.
      </div>
    )
  }

  const { propertyId } = await searchParams

  const [allReminders, portfolio] = await Promise.all([
    getIAdminReminders(administrationId, { status: 'all', limit: 200 }),
    getIAdminPortfolio(administrationId),
  ])

  const reminders = propertyId
    ? allReminders.filter((r) => r.managedPropertyId === propertyId)
    : allReminders
  const scopedProperty = propertyId
    ? portfolio?.properties.find((p) => p.id === propertyId) ?? null
    : null

  return (
    <div className="space-y-6">
      <header className="glass-card rounded-2xl p-6">
        <p className="text-xs uppercase tracking-wider text-primary font-medium">Recordatorios</p>
        <h1 className="font-serif text-2xl font-bold text-foreground mt-1">
          {scopedProperty ? `Recordatorios · ${scopedProperty.displayName ?? scopedProperty.buildingName}` : 'Bandeja de avisos'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Generá recordatorios del día según los vencimientos y el estado de pago de cada vecino.
          Mandás por WhatsApp con un click y se marca automáticamente como enviado.
        </p>
      </header>

      {scopedProperty ? (
        <ScopedToBuildingBanner
          propertyName={scopedProperty.displayName ?? scopedProperty.buildingName}
          basePath="/iadmin/recordatorios"
        />
      ) : null}

      <RemindersInbox
        administrationId={administrationId}
        reminders={reminders}
        properties={(portfolio?.properties ?? []).map((p) => ({
          id: p.id,
          displayName: p.displayName,
          buildingName: p.buildingName,
        }))}
      />
    </div>
  )
}
