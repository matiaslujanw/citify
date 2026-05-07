'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  ArrowLeft,
  Banknote,
  Bell,
  BellRing,
  Building2,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Receipt,
  ScrollText,
  Settings,
  Wallet,
} from 'lucide-react'
import type { IAdminCapability } from '@/lib/types'

type BuildingNavItem = {
  href: string
  label: string
  icon: typeof Building2
  need: IAdminCapability
  group: 'main' | 'workflows' | 'config'
}

const GLOBAL_NAV_ITEMS: ReadonlyArray<{
  href: string
  label: string
  icon: typeof Building2
  need: IAdminCapability
  matchPrefix?: string
}> = [
  { href: '/iadmin/cartera', label: 'Cartera', icon: Building2, need: 'portfolio.view', matchPrefix: '/iadmin/cartera' },
  { href: '/iadmin/gastos', label: 'Gastos', icon: Receipt, need: 'expenses.view', matchPrefix: '/iadmin/gastos' },
  { href: '/iadmin/liquidaciones', label: 'Liquidaciones', icon: ScrollText, need: 'liquidations.view', matchPrefix: '/iadmin/liquidaciones' },
  { href: '/iadmin/cobranzas', label: 'Cobranzas', icon: Wallet, need: 'collections.view', matchPrefix: '/iadmin/cobranzas' },
  { href: '/iadmin/recordatorios', label: 'Recordatorios', icon: BellRing, need: 'reminders.generate', matchPrefix: '/iadmin/recordatorios' },
]

const CONSORCIO_DETAIL_RE = /^\/iadmin\/consorcios\/([^/]+)/

function buildingScopedItems(consorcioId: string): BuildingNavItem[] {
  return [
    {
      href: `/iadmin/consorcios/${consorcioId}/resumen`,
      label: 'Resumen',
      icon: LayoutDashboard,
      need: 'consorcio.view',
      group: 'main',
    },
    {
      href: `/iadmin/consorcios/${consorcioId}/movimientos`,
      label: 'Movimientos',
      icon: ListChecks,
      need: 'consorcio.view',
      group: 'main',
    },
    {
      href: `/iadmin/gastos?propertyId=${consorcioId}`,
      label: 'Gastos',
      icon: Receipt,
      need: 'expenses.view',
      group: 'workflows',
    },
    {
      href: `/iadmin/liquidaciones?propertyId=${consorcioId}`,
      label: 'Liquidaciones',
      icon: ScrollText,
      need: 'liquidations.view',
      group: 'workflows',
    },
    {
      href: `/iadmin/cobranzas?propertyId=${consorcioId}`,
      label: 'Cobranzas',
      icon: Wallet,
      need: 'collections.view',
      group: 'workflows',
    },
    {
      href: `/iadmin/consorcios/${consorcioId}/comprobantes`,
      label: 'Comprobantes',
      icon: Inbox,
      need: 'collections.view',
      group: 'workflows',
    },
    {
      href: `/iadmin/recordatorios?propertyId=${consorcioId}`,
      label: 'Recordatorios',
      icon: BellRing,
      need: 'reminders.generate',
      group: 'workflows',
    },
    {
      href: `/iadmin/consorcios/${consorcioId}/configuracion`,
      label: 'Configuración',
      icon: Settings,
      need: 'consorcio.view',
      group: 'config',
    },
  ]
}

export function IAdminNav({ allowedCapabilities }: { allowedCapabilities: IAdminCapability[] }) {
  const pathname = usePathname() ?? ''
  const searchParams = useSearchParams()
  const allowed = new Set(allowedCapabilities)
  const consorcioMatch = pathname.match(CONSORCIO_DETAIL_RE)
  const propertyIdParam = searchParams?.get('propertyId') ?? null
  const activeConsorcioId = consorcioMatch ? consorcioMatch[1] : propertyIdParam

  if (activeConsorcioId) {
    const consorcioId = activeConsorcioId
    const items = buildingScopedItems(consorcioId).filter((it) => allowed.has(it.need))
    const renderItem = (item: BuildingNavItem) => {
      const hrefPath = item.href.split('?')[0]
      const isActive = pathname === hrefPath || pathname.startsWith(hrefPath + '/')
      const Icon = item.icon
      return (
        <Link
          key={item.href}
          href={item.href}
          className={[
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
            isActive
              ? 'bg-primary/10 text-foreground font-medium'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          ].join(' ')}
        >
          <Icon className="w-4 h-4" />
          {item.label}
        </Link>
      )
    }

    const main = items.filter((it) => it.group === 'main')
    const workflows = items.filter((it) => it.group === 'workflows')
    const config = items.filter((it) => it.group === 'config')

    return (
      <nav className="flex flex-col gap-1 p-3">
        <Link
          href="/iadmin/cartera"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Volver a Cartera
        </Link>
        <div className="my-1 h-px bg-border/40" />
        {main.map(renderItem)}
        {workflows.length > 0 ? (
          <>
            <div className="mt-3 mb-1 px-3 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              Operaciones
            </div>
            {workflows.map(renderItem)}
          </>
        ) : null}
        {config.length > 0 ? (
          <>
            <div className="my-2 h-px bg-border/40" />
            {config.map(renderItem)}
          </>
        ) : null}
      </nav>
    )
  }

  return (
    <nav className="flex flex-col gap-1 p-3">
      {GLOBAL_NAV_ITEMS.filter((item) => allowed.has(item.need)).map((item) => {
        const isActive = item.matchPrefix ? pathname.startsWith(item.matchPrefix) : pathname === item.href
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            className={[
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-primary/10 text-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            ].join(' ')}
          >
            <Icon className="w-4 h-4" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

export function IAdminNotificationsBadge() {
  return (
    <button
      type="button"
      className="relative rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label="Notificaciones"
    >
      <Bell className="w-4 h-4" />
    </button>
  )
}

export function IAdminBalanceHint() {
  return (
    <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground">
      <Banknote className="w-3.5 h-3.5" />
      Cierre del periodo en curso
    </div>
  )
}
