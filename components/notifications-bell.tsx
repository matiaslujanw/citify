'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bell, Check, CheckCheck, Loader2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  listMyNotifications,
  markAllRead,
  markNotificationsRead,
  type UserNotificationRow,
} from '@/app/notificaciones/actions'

const POLL_MS = 60_000

export function NotificationsBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<UserNotificationRow[]>([])
  const [loading, setLoading] = useState(false)
  const [, startTransition] = useTransition()
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  async function refresh() {
    try {
      const data = await listMyNotifications(20)
      setItems(data)
    } catch {
      // silent
    }
  }

  useEffect(() => {
    void refresh()
    pollTimer.current = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [])

  // Cuando se abre el dropdown, refrescamos.
  useEffect(() => {
    if (open) void refresh()
  }, [open])

  const unreadCount = useMemo(() => items.filter((i) => !i.readAt).length, [items])

  async function handleClickItem(it: UserNotificationRow) {
    setOpen(false)
    if (!it.readAt) {
      try {
        await markNotificationsRead({ ids: [it.id] })
      } catch {}
    }
    if (it.link) {
      router.push(it.link)
    }
    startTransition(() => router.refresh())
    void refresh()
  }

  async function handleMarkAll() {
    setLoading(true)
    try {
      await markAllRead()
      await refresh()
      startTransition(() => router.refresh())
    } finally {
      setLoading(false)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Notificaciones"
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0 max-h-[480px] overflow-hidden flex flex-col">
        <div className="px-3 py-2 flex items-center justify-between border-b border-border/40">
          <p className="text-sm font-medium">Notificaciones</p>
          {unreadCount > 0 ? (
            <button
              type="button"
              onClick={() => void handleMarkAll()}
              disabled={loading}
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCheck className="w-3 h-3" />}
              Marcar todas
            </button>
          ) : null}
        </div>

        <div className="overflow-y-auto flex-1">
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">No tenés notificaciones todavía.</p>
          ) : (
            <ul className="divide-y divide-border/40">
              {items.slice(0, 10).map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    onClick={() => void handleClickItem(it)}
                    className={[
                      'w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors',
                      !it.readAt ? 'bg-primary/5' : '',
                    ].join(' ')}
                  >
                    <div className="flex items-start gap-2">
                      {!it.readAt ? (
                        <span className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
                      ) : (
                        <span className="w-2 h-2 mt-1.5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm ${!it.readAt ? 'font-medium text-foreground' : 'text-muted-foreground'} truncate`}>
                          {it.title}
                        </p>
                        {it.body ? (
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{it.body}</p>
                        ) : null}
                        <p className="text-[10px] text-muted-foreground mt-1">
                          {formatRelative(it.createdAt)}
                        </p>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border/40 p-2">
          <Link
            href="/notificaciones"
            onClick={() => setOpen(false)}
            className="block text-center text-xs text-primary hover:underline py-1"
          >
            Ver todas
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'hace instantes'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `hace ${days} d`
  return new Date(iso).toLocaleDateString('es-AR')
}
