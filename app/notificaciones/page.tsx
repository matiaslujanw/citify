import { Bell } from 'lucide-react'
import { NotificationsInbox } from '@/components/notifications-inbox'
import { listMyNotifications } from '@/app/notificaciones/actions'
import { requireProfile } from '@/lib/auth'

export default async function NotificacionesPage() {
  await requireProfile()
  const items = await listMyNotifications(100)

  return (
    <div className="min-h-screen bg-background pt-20">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <header className="glass-card rounded-2xl p-6 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Bell className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-primary font-medium">Bandeja</p>
              <h1 className="font-serif text-2xl font-bold text-foreground">Notificaciones</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Acá llegan los avisos que te mandan los administradores: liquidaciones nuevas, pagos aprobados o rechazados, etc.
              </p>
            </div>
          </div>
        </header>

        <NotificationsInbox initialItems={items} />
      </div>
    </div>
  )
}
