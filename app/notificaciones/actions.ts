'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireProfile } from '@/lib/auth'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export type UserNotificationRow = {
  id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  readAt: string | null
  createdAt: string
}

export async function listMyNotifications(limit = 50): Promise<UserNotificationRow[]> {
  const { profile } = await requireProfile()
  const supabase = await getSupabaseServerClient()
  if (!supabase) return []

  const { data } = await supabase
    .from('user_notifications')
    .select('id, kind, title, body, link, read_at, created_at')
    .eq('recipient_profile_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  return (data ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    title: r.title as string,
    body: (r.body as string | null) ?? null,
    link: (r.link as string | null) ?? null,
    readAt: (r.read_at as string | null) ?? null,
    createdAt: r.created_at as string,
  }))
}

export async function getMyUnreadCount(): Promise<number> {
  const { profile } = await requireProfile()
  const supabase = await getSupabaseServerClient()
  if (!supabase) return 0
  const { count } = await supabase
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_profile_id', profile.id)
    .is('read_at', null)
  return count ?? 0
}

const markReadSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
})

export async function markNotificationsRead(input: z.input<typeof markReadSchema>): Promise<{ updated: number }> {
  const parsed = markReadSchema.parse(input)
  const { profile } = await requireProfile()
  const supabase = await getSupabaseServerClient()
  if (!supabase) return { updated: 0 }
  const { data } = await supabase
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_profile_id', profile.id)
    .in('id', parsed.ids)
    .is('read_at', null)
    .select('id')
  revalidatePath('/notificaciones')
  return { updated: data?.length ?? 0 }
}

export async function markAllRead(): Promise<{ updated: number }> {
  const { profile } = await requireProfile()
  const supabase = await getSupabaseServerClient()
  if (!supabase) return { updated: 0 }
  const { data } = await supabase
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_profile_id', profile.id)
    .is('read_at', null)
    .select('id')
  revalidatePath('/notificaciones')
  return { updated: data?.length ?? 0 }
}
