import { getSupabaseServerClient } from '@/lib/supabase/server'

export type UserNotificationKind =
  | 'liquidation_emitted'
  | 'payment_receipt_approved'
  | 'payment_receipt_rejected'

export type EnqueueNotificationInput = {
  recipientProfileId: string
  kind: UserNotificationKind
  title: string
  body?: string | null
  link?: string | null
  liquidationRunId?: string | null
  liquidationItemId?: string | null
  paymentReceiptId?: string | null
}

/**
 * Inserta una notificación in-app para un usuario.
 * Diseñado para ser llamado desde server actions, NO falla si el insert se
 * pisa con RLS — devuelve null y deja que el flujo principal continúe.
 */
export async function enqueueUserNotification(
  input: EnqueueNotificationInput,
): Promise<string | null> {
  const supabase = await getSupabaseServerClient()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('user_notifications')
    .insert({
      recipient_profile_id: input.recipientProfileId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      liquidation_run_id: input.liquidationRunId ?? null,
      liquidation_item_id: input.liquidationItemId ?? null,
      payment_receipt_id: input.paymentReceiptId ?? null,
    })
    .select('id')
    .maybeSingle()
  if (error || !data) return null
  return data.id as string
}

/** Versión bulk: inserta varias notificaciones en una sola query. */
export async function enqueueUserNotifications(
  inputs: EnqueueNotificationInput[],
): Promise<number> {
  if (inputs.length === 0) return 0
  const supabase = await getSupabaseServerClient()
  if (!supabase) return 0
  const rows = inputs.map((i) => ({
    recipient_profile_id: i.recipientProfileId,
    kind: i.kind,
    title: i.title,
    body: i.body ?? null,
    link: i.link ?? null,
    liquidation_run_id: i.liquidationRunId ?? null,
    liquidation_item_id: i.liquidationItemId ?? null,
    payment_receipt_id: i.paymentReceiptId ?? null,
  }))
  const { data } = await supabase.from('user_notifications').insert(rows).select('id')
  return data?.length ?? 0
}
