'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { Building2 } from 'lucide-react'
import type { IAdminCapability } from '@/lib/types'
import { IAdminNav } from './iadmin-nav'

const CONSORCIO_DETAIL_RE = /^\/iadmin\/consorcios\/([^/]+)/

export function IAdminShellAside({
  primaryAdminName,
  primaryRole,
  allowedCapabilities,
}: {
  primaryAdminName: string
  primaryRole: string | null
  allowedCapabilities: IAdminCapability[]
}) {
  const pathname = usePathname() ?? ''
  const searchParams = useSearchParams()
  // Mostramos el sidebar cuando el admin está adentro de un edificio.
  // En la Cartera (sin propertyId) queda toda la pantalla disponible
  // para que primero elija con qué consorcio quiere trabajar.
  const insideConsorcio =
    CONSORCIO_DETAIL_RE.test(pathname) || Boolean(searchParams?.get('propertyId'))
  if (!insideConsorcio) return null

  return (
    <aside className="hidden lg:block w-64 shrink-0">
      <div className="glass-card sticky top-20 rounded-2xl">
        <div className="border-b border-border/40 px-4 py-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-primary">
            <Building2 className="w-3.5 h-3.5" />
            Backoffice administrador
          </div>
          <div className="mt-1 text-base font-semibold text-foreground">{primaryAdminName}</div>
          {primaryRole ? (
            <div className="text-xs text-muted-foreground mt-0.5">Rol: {primaryRole}</div>
          ) : null}
        </div>
        <IAdminNav allowedCapabilities={allowedCapabilities} />
      </div>
    </aside>
  )
}
