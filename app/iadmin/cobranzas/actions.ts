'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireIAdmin } from '@/lib/auth'
import { getSupabaseServerClient } from '@/lib/supabase/server'

const registerSchema = z.object({
  liquidationItemId: z.string().uuid(),
  cashAccountId: z.string().uuid(),
  amount: z.number().positive(),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueLabel: z.string().trim().max(40).optional(),
  surchargeAmount: z.number().min(0).optional().default(0),
  method: z.string().trim().max(40).optional(),
  reference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
})

export async function registerCollection(input: z.input<typeof registerSchema>) {
  const parsed = registerSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // Traer item con la cadena hasta administration
  const { data: item } = await supabase
    .from('iadmin_liquidation_items')
    .select(`
      id,
      unit_id,
      liquidation_run_id,
      iadmin_liquidation_runs!inner (
        administration_id,
        managed_property_id,
        status
      )
    `)
    .eq('id', parsed.liquidationItemId)
    .maybeSingle()

  if (!item) throw new Error('Item de liquidacion no encontrado')

  const run = Array.isArray(item.iadmin_liquidation_runs)
    ? item.iadmin_liquidation_runs[0]
    : item.iadmin_liquidation_runs
  const administrationId = run?.administration_id as string
  const managedPropertyId = run?.managed_property_id as string

  const { profile } = await requireIAdmin({
    capability: 'collections.register',
    administrationId,
  })

  // Validar que la cuenta pertenezca al mismo consorcio
  const { data: account } = await supabase
    .from('iadmin_cash_accounts')
    .select('id, managed_property_id, name')
    .eq('id', parsed.cashAccountId)
    .maybeSingle()
  if (!account) throw new Error('Cuenta no encontrada')
  if (account.managed_property_id !== managedPropertyId) {
    throw new Error('La cuenta no pertenece al consorcio del item')
  }

  // Crear el movimiento bancario de cobranza primero (ingreso = amount positivo)
  const { data: movement, error: movementError } = await supabase
    .from('iadmin_bank_movements')
    .insert({
      administration_id: administrationId,
      managed_property_id: managedPropertyId,
      cash_account_id: parsed.cashAccountId,
      movement_date: parsed.paidAt,
      description: `Cobranza expensas`,
      amount: parsed.amount,
      external_ref: parsed.reference ?? null,
      movement_kind: 'collection',
      created_by: profile.id,
    })
    .select('id')
    .single()

  if (movementError) throw new Error(movementError.message)

  // Obtener N° de recibo atomico via RPC
  const { data: receiptNumber, error: receiptError } = await supabase.rpc('iadmin_next_receipt_number', {
    admin_id: administrationId,
  })

  if (receiptError) throw new Error(receiptError.message)

  // Insertar el pago linkeado al movimiento
  const { data: payment, error } = await supabase
    .from('iadmin_payments')
    .insert({
      administration_id: administrationId,
      managed_property_id: managedPropertyId,
      liquidation_run_id: item.liquidation_run_id,
      liquidation_item_id: parsed.liquidationItemId,
      unit_id: item.unit_id,
      cash_account_id: parsed.cashAccountId,
      bank_movement_id: movement.id,
      amount: parsed.amount,
      surcharge_amount: parsed.surchargeAmount ?? 0,
      paid_at: parsed.paidAt,
      method: parsed.method ?? null,
      reference: parsed.reference ?? null,
      receipt_number: receiptNumber,
      due_label: parsed.dueLabel ?? null,
      notes: parsed.notes ?? null,
      created_by: profile.id,
    })
    .select('id, receipt_number')
    .single()

  if (error) {
    // Rollback del movement si el payment fallo
    await supabase.from('iadmin_bank_movements').delete().eq('id', movement.id)
    throw new Error(error.message)
  }

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: administrationId,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_payments',
    entity_id: payment.id,
    action: 'payment.registered',
    metadata: {
      amount: parsed.amount,
      receipt_number: payment.receipt_number,
      item_id: parsed.liquidationItemId,
    },
  })

  revalidatePath(`/iadmin/liquidaciones/${item.liquidation_run_id}`)
  revalidatePath(`/iadmin/consorcios/${managedPropertyId}`, "layout")
  revalidatePath(`/iadmin/consorcios/${managedPropertyId}/cuentas`)
  revalidatePath(`/iadmin/cobranzas`)

  return { id: payment.id as string, receiptNumber: payment.receipt_number as string }
}

const voidSchema = z.object({
  paymentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
})

export async function voidCollection(input: z.input<typeof voidSchema>) {
  const parsed = voidSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: payment } = await supabase
    .from('iadmin_payments')
    .select('id, administration_id, managed_property_id, liquidation_run_id, bank_movement_id, is_void')
    .eq('id', parsed.paymentId)
    .maybeSingle()
  if (!payment) throw new Error('Pago no encontrado')
  if (payment.is_void) throw new Error('El pago ya esta anulado')

  const { profile } = await requireIAdmin({
    capability: 'collections.void',
    administrationId: payment.administration_id,
  })

  // Marcar anulado
  const { error } = await supabase
    .from('iadmin_payments')
    .update({
      is_void: true,
      voided_at: new Date().toISOString(),
      voided_by: profile.id,
      void_reason: parsed.reason,
    })
    .eq('id', parsed.paymentId)

  if (error) throw new Error(error.message)

  // Borrar el movimiento bancario asociado (el pago ya no suma al saldo)
  if (payment.bank_movement_id) {
    await supabase.from('iadmin_bank_movements').delete().eq('id', payment.bank_movement_id)
  }

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: payment.administration_id,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_payments',
    entity_id: parsed.paymentId,
    action: 'payment.voided',
    metadata: { reason: parsed.reason },
  })

  if (payment.liquidation_run_id) {
    revalidatePath(`/iadmin/liquidaciones/${payment.liquidation_run_id}`)
  }
  if (payment.managed_property_id) {
    revalidatePath(`/iadmin/consorcios/${payment.managed_property_id}`, "layout")
    revalidatePath(`/iadmin/consorcios/${payment.managed_property_id}/cuentas`)
  }
  revalidatePath(`/iadmin/cobranzas`)
}
