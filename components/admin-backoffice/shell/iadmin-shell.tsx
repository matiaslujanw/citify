import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import type { IAdminContext } from '@/lib/types'
import { IAdminBalanceHint, IAdminNotificationsBadge } from './iadmin-nav'
import { IAdminShellAside } from './iadmin-shell-aside'
import { ChatWidget } from '@/components/ai/chat-widget'

export function IAdminShell({
  context,
  children,
  breadcrumbs,
}: {
  context: IAdminContext
  children: React.ReactNode
  breadcrumbs?: Array<{ label: string; href?: string }>
}) {
  const primary = context.primary
  const allowedCapabilities = primary?.capabilities ?? []

  return (
    <>
    <div className="min-h-screen bg-background pt-16">
      <div className="mx-auto flex max-w-[1400px] gap-6 px-6 py-6">
        <IAdminShellAside
          primaryAdminName={primary?.administration.name ?? 'Sin administración'}
          primaryRole={primary?.operationalRole ?? null}
          allowedCapabilities={allowedCapabilities}
        />

        <main className="min-w-0 flex-1">
          <header className="mb-6 flex items-center justify-between">
            <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Link href="/iadmin" className="hover:text-foreground">
                IAdmin
              </Link>
              {breadcrumbs?.map((crumb, idx) => (
                <span key={`${crumb.label}-${idx}`} className="flex items-center gap-1.5">
                  <ChevronRight className="w-3 h-3" />
                  {crumb.href ? (
                    <Link href={crumb.href} className="hover:text-foreground">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="text-foreground">{crumb.label}</span>
                  )}
                </span>
              ))}
            </nav>
            <div className="flex items-center gap-3">
              <IAdminBalanceHint />
              <IAdminNotificationsBadge />
            </div>
          </header>

          {children}
        </main>
      </div>
    </div>

      <ChatWidget
        suggestions={[
          '¿Cuántos vecinos registrados hay?',
          '¿Qué expedientes están activos?',
          '¿Cuál es la ocupación de los edificios?',
          '¿Qué edificios tengo a cargo?',
        ]}
        welcomeText="Puedo responder preguntas sobre tus edificios, vecinos y expedientes."
      />
    </>
  )
}
