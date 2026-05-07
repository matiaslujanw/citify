import Link from 'next/link'
import { ArrowRight, Inbox } from 'lucide-react'
import { MovimientosView } from '@/components/admin-backoffice/consorcio/movimientos-view'
import { can, requireIAdmin } from '@/lib/auth'
import { getIAdminMonthlyGrid } from '@/lib/data'

export default async function MovimientosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { context } = await requireIAdmin({ capability: 'consorcio.view' })

  const grid = await getIAdminMonthlyGrid(id, { monthsCount: 2 })
  if (!grid) {
    return (
      <div className="glass-card rounded-2xl p-10 text-center space-y-3">
        <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
          <Inbox className="w-6 h-6 text-primary" />
        </div>
        <h2 className="font-serif text-xl font-bold text-foreground">Sin datos para mostrar</h2>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          No pudimos cargar la información del consorcio. Revisá la configuración.
        </p>
        <Link
          href={`/iadmin/consorcios/${id}/configuracion`}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Ir a configuración
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    )
  }

  const canManageRubros = can(context, 'providers.manage', { administrationId: grid.administrationId })

  return <MovimientosView grid={grid} canManageRubros={canManageRubros} />
}
