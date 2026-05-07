'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCheck, Loader2, MailCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  markAllRead,
  markNotificationsRead,
  type UserNotificationRow,
} from '@/app/notificaciones/actions'

const KIND_LABEL: Record<string, string> = {
  liquidation_emitted: 'Nueva liquidación',
  payment_receipt_approved: 'Pago aprobado',
  payment_receipt_rejected: 'Pago rechazado',
}

export function NotificationsInbox({ initialItems }: { initialItems: UserNotificationRow[] }) {
  const router = useRouter()
  const [items, setItems] = useState(initialItems)
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()

  const visible = filter === 'unread' ? items.filter((i) => !i.readAt) : items
  const unreadCount = items.filter((i) => !i.readAt).length

  async function handleClickItem(it: UserNotificationRow) {
    if (!it.readAt) {
      try {
        await markNotificationsRead({ ids: [it.id] })
        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, readAt: new Date().toISOString() } : x)))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'No se pudo marcar')
      }
    }
    if (it.link) {
      router.push(it.link)
    }
  }

  async function handleMarkAll() {
    setBusy(true)
    try {
      const { updated } = await markAllRead()
      setItems((prev) => prev.map((x) => (x.readAt ? x : { ...x, readAt: new Date().toISOString() })))
      toast.success(`${updated} notificaciones marcadas`)
      startTransition(() => router.refresh())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          {(['all', 'unread'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={[
                'px-3 py-1.5 rounded-full text-xs transition-colors',
                filter === f
                  ? 'bg-primary text-primary-foreground font-medium'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground',
              ].join(' ')}
            >
              {f === 'all' ? `Todas (${items.length})` : `No leídas (${unreadCount})`}
            </button>
          ))}
        </div>
        {unreadCount > 0 ? (
          <Button size="sm" variant="outline" onClick={() => void handleMarkAll()} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <CheckCheck className="w-4 h-4 mr-1.5" />}
            Marcar todas como leídas
          </Button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <div className="glass-card rounded-2xl p-12 text-center space-y-2">
          <MailCheck className="w-8 h-8 text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">
            {filter === 'unread' ? 'No tenés notificaciones sin leer.' : 'No tenés notificaciones todavía.'}
          </p>
        </div>
      ) : (
        <ul className="glass-card rounded-2xl divide-y divide-border/40 overflow-hidden">
          {visible.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                onClick={() => void handleClickItem(it)}
                className={[
                  'w-full text-left px-5 py-4 hover:bg-muted/40 transition-colors',
                  !it.readAt ? 'bg-primary/5' : '',
                ].join(' ')}
              >
                <div className="flex items-start gap-3">
                  {!it.readAt ? (
                    <span className="w-2 h-2 rounded-full bg-primary mt-2 shrink-0" />
                  ) : (
                    <span className="w-2 h-2 mt-2 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`text-sm ${!it.readAt ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                        {it.title}
                      </p>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {KIND_LABEL[it.kind] ?? it.kind}
                      </span>
                    </div>
                    {it.body ? (
                      <p className="text-xs text-muted-foreground mt-1">{it.body}</p>
                    ) : null}
                    <p className="text-[10px] text-muted-foreground mt-1.5">
                      {new Date(it.createdAt).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })}
                    </p>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
