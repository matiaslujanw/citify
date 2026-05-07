'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { CircleAlert, LogOut, UserRound, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ThemeToggle } from '@/components/theme-toggle'
import { NotificationsBell } from '@/components/notifications-bell'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import { ROLE_HOME, ROLE_LABELS } from '@/lib/constants'
import type { UserRole } from '@/lib/types'

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false)
  const [authResolved, setAuthResolved] = useState(false)
  const [userState, setUserState] = useState<{ fullName: string; role: UserRole } | null>(null)
  const router = useRouter()
  const pathname = usePathname()

  if (pathname?.startsWith('/print') || pathname?.startsWith('/l/')) {
    return null
  }

  useEffect(() => {
    const supabase = getSupabaseBrowserClient()
    if (!supabase) {
      setAuthResolved(true)
      return
    }

    let active = true

    async function loadSession() {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user || !active) {
        setUserState(null)
        setAuthResolved(true)
        return
      }

      const { data } = await supabase.from('profiles').select('full_name, role').eq('id', user.id).maybeSingle()
      if (!active) {
        return
      }

      if (data?.role) {
        setUserState({ fullName: data.full_name ?? 'Usuario', role: data.role as UserRole })
      } else {
        setUserState(null)
      }

      setAuthResolved(true)
    }

    void loadSession()

    const listener = supabase.auth.onAuthStateChange(() => {
      void loadSession()
    })

    return () => {
      active = false
      listener.data.subscription.unsubscribe()
    }
  }, [])

  async function handleLogout() {
    const supabase = getSupabaseBrowserClient()
    if (!supabase) {
      return
    }

    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  function closeMobileMenu() {
    setMobileOpen(false)
  }

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  return (
    <header className="fixed left-0 right-0 top-0 z-50 border-b border-border/60 bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2" onClick={closeMobileMenu}>
          <Image
            src="/citify-logo.png"
            alt="Citify"
            width={142}
            height={108}
            priority
            className="h-8 w-auto"
          />
          <span className="text-lg font-semibold tracking-tight text-foreground">Citify</span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {userState ? (
            <>
              <Link
                href={ROLE_HOME[userState.role]}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium"
                style={{
                  background: 'rgba(240, 78, 35, 0.08)',
                  border: '1px solid rgba(240, 78, 35, 0.2)',
                  color: 'var(--muted-foreground)',
                }}
              >
                <UserRound className="h-3.5 w-3.5" />
                {userState.fullName} · <span className="font-semibold text-foreground">{ROLE_LABELS[userState.role]}</span>
              </Link>
              <NotificationsBell />
              <Button variant="outline" size="sm" className="gap-2" onClick={() => setLogoutDialogOpen(true)}>
                <LogOut className="h-4 w-4" />
                Salir
              </Button>
              <ThemeToggle />
            </>
          ) : authResolved ? (
            <>
              <span
                className="rounded-full px-4 py-2 text-xs font-medium"
                style={{
                  background: 'rgba(240, 78, 35, 0.08)',
                  border: '1px solid rgba(240, 78, 35, 0.2)',
                  color: 'var(--muted-foreground)',
                }}
              >
                desarrollado por <span className="font-semibold text-foreground">Digital Amenities</span>
              </span>
              <Link href="/login">
                <Button size="sm" className="btn-premium">
                  Ingresar
                </Button>
              </Link>
              <ThemeToggle />
            </>
          ) : (
            <div className="flex items-center gap-3">
              <div className="h-9 w-44 animate-pulse rounded-full bg-muted/70" />
              <ThemeToggle />
            </div>
          )}
        </nav>

        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <button
            data-tour="neighbor-mobile-menu-toggle"
            className="rounded-full border border-border/60 bg-background/80 p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => setMobileOpen((current) => !current)}
            aria-label={mobileOpen ? 'Cerrar menú' : 'Abrir menú de usuario'}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <UserRound className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileOpen ? (
        <div className="flex flex-col gap-3 border-t border-border bg-background/98 px-6 py-4 md:hidden">
          {userState ? (
            <>
              <div className="py-1 text-center text-sm text-muted-foreground">
                {userState.fullName} · <span className="font-semibold text-foreground">{ROLE_LABELS[userState.role]}</span>
              </div>
              <Link href={ROLE_HOME[userState.role]} className="w-full" onClick={closeMobileMenu}>
                <Button className="w-full btn-premium">Ir a mi panel</Button>
              </Link>
              {userState.role === 'vecino' ? (
                <>
                  <Link href="/usuario?view=household" className="w-full" onClick={closeMobileMenu} data-tour="neighbor-mobile-household">
                    <Button variant="outline" className="w-full justify-start gap-2">
                      <Users className="h-4 w-4" />
                      Mi unidad
                    </Button>
                  </Link>
                  <Link href="/usuario?view=complaints" className="w-full" onClick={closeMobileMenu} data-tour="neighbor-mobile-complaints">
                    <Button variant="outline" className="w-full justify-start gap-2">
                      <CircleAlert className="h-4 w-4" />
                      Expedientes
                    </Button>
                  </Link>
                </>
              ) : null}
              <Button variant="outline" className="w-full gap-2" onClick={() => setLogoutDialogOpen(true)}>
                <LogOut className="h-4 w-4" />
                Salir
              </Button>
            </>
          ) : authResolved ? (
            <>
              <span className="py-2 text-center text-sm font-medium text-muted-foreground">
                desarrollado por <span className="font-semibold text-foreground">Digital Amenities</span>
              </span>
              <Link href="/login" className="w-full" onClick={closeMobileMenu}>
                <Button className="w-full btn-premium">Ingresar</Button>
              </Link>
            </>
          ) : (
            <div className="space-y-3">
              <div className="h-10 animate-pulse rounded-xl bg-muted/70" />
              <div className="h-10 animate-pulse rounded-xl bg-muted/70" />
            </div>
          )}
        </div>
      ) : null}
      <AlertDialog open={logoutDialogOpen} onOpenChange={setLogoutDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cerrar sesion</AlertDialogTitle>
            <AlertDialogDescription>Vas a cerrar tu sesion actual en este dispositivo.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleLogout()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Si, salir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  )
}
