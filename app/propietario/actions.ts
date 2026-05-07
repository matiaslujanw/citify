'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireProfile } from '@/lib/auth'
import { getSupabaseServerClient } from '@/lib/supabase/server'

const submitSchema = z.object({
  liquidationItemId: z.string().uuid(),
  amount: z.number().positive(),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.string().trim().max(40).optional(),
  reference: z.string().trim().max(120).optional(),
  receiptPath: z.string().trim().max(400).optional(),
  notes: z.string().trim().max(500).optional(),
})

export type SubmittedReceipt = {
  id: string
  amount: number
  paidAt: string
  method: string | null
  reference: string | null
  receiptPath: string | null
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

export async function submitPaymentReceipt(
  input: z.input<typeof submitSchema>,
): Promise<SubmittedReceipt> {
  const parsed = submitSchema.parse(input)
  const { profile } = await requireProfile(['propietario', 'super_admin'])
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // Verificar que el profile sea propietario activo de la unidad del item
  const { data: item } = await supabase
    .from('iadmin_liquidation_items')
    .select('id, unit_id')
    .eq('id', parsed.liquidationItemId)
    .maybeSingle()
  if (!item) throw new Error('Liquidación no encontrada')

  const { data: membership } = await supabase
    .from('unit_profile_memberships')
    .select('id')
    .eq('unit_id', item.unit_id)
    .eq('profile_id', profile.id)
    .eq('relationship_type', 'propietario')
    .eq('active', true)
    .maybeSingle()
  if (!membership && profile.role !== 'super_admin') {
    throw new Error('No sos propietario activo de esta unidad')
  }

  const { data: inserted, error } = await supabase
    .from('iadmin_payment_receipts')
    .insert({
      liquidation_item_id: parsed.liquidationItemId,
      submitted_by_profile_id: profile.id,
      amount: parsed.amount,
      paid_at: parsed.paidAt,
      method: parsed.method ?? null,
      reference: parsed.reference ?? null,
      receipt_path: parsed.receiptPath ?? null,
      notes: parsed.notes ?? null,
      status: 'pending',
    })
    .select('id, amount, paid_at, method, reference, receipt_path, status, created_at')
    .single()
  if (error || !inserted) throw new Error(error?.message ?? 'No se pudo guardar el comprobante')

  revalidatePath('/propietario')
  return {
    id: inserted.id as string,
    amount: Number(inserted.amount),
    paidAt: inserted.paid_at as string,
    method: (inserted.method as string | null) ?? null,
    reference: (inserted.reference as string | null) ?? null,
    receiptPath: (inserted.receipt_path as string | null) ?? null,
    status: inserted.status as 'pending' | 'approved' | 'rejected',
    createdAt: inserted.created_at as string,
  }
}

export async function getMyReceiptsForItem(liquidationItemId: string): Promise<SubmittedReceipt[]> {
  const { profile } = await requireProfile(['propietario', 'super_admin'])
  const supabase = await getSupabaseServerClient()
  if (!supabase) return []

  const { data: rows } = await supabase
    .from('iadmin_payment_receipts')
    .select('id, amount, paid_at, method, reference, receipt_path, status, created_at')
    .eq('liquidation_item_id', liquidationItemId)
    .eq('submitted_by_profile_id', profile.id)
    .order('created_at', { ascending: false })

  return (rows ?? []).map((r) => ({
    id: r.id as string,
    amount: Number(r.amount),
    paidAt: r.paid_at as string,
    method: (r.method as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    receiptPath: (r.receipt_path as string | null) ?? null,
    status: r.status as 'pending' | 'approved' | 'rejected',
    createdAt: r.created_at as string,
  }))
}
