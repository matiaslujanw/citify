'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireIAdmin } from '@/lib/auth'
import { getSupabaseServerClient } from '@/lib/supabase/server'

async function getPropertyAdminId(propertyId: string) {
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')
  const { data } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id')
    .eq('id', propertyId)
    .maybeSingle()
  if (!data) throw new Error('Consorcio no encontrado')
  return { supabase, administrationId: data.administration_id as string }
}

// ----------------------------------------------------------------------------
// Cuentas bancarias / caja
// ----------------------------------------------------------------------------

const accountFields = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['bank', 'cash', 'reserve', 'other']),
  bankName: z.string().trim().max(80).nullable().optional(),
  accountNumber: z.string().trim().max(40).nullable().optional(),
  cbu: z.string().trim().max(32).nullable().optional(),
  alias: z.string().trim().max(40).nullable().optional(),
  openingBalance: z.number().optional().default(0),
  openingBalanceAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
})

const createAccountSchema = accountFields.extend({
  propertyId: z.string().uuid(),
})

export async function createCashAccount(input: z.input<typeof createAccountSchema>) {
  const parsed = createAccountSchema.parse(input)
  const { supabase, administrationId } = await getPropertyAdminId(parsed.propertyId)
  const { profile } = await requireIAdmin({
    capability: 'cash_accounts.manage',
    administrationId,
  })

  const { data, error } = await supabase
    .from('iadmin_cash_accounts')
    .insert({
      managed_property_id: parsed.propertyId,
      name: parsed.name,
      kind: parsed.kind,
      bank_name: parsed.bankName ?? null,
      account_number: parsed.accountNumber ?? null,
      cbu: parsed.cbu ?? null,
      alias: parsed.alias ?? null,
      opening_balance: parsed.openingBalance ?? 0,
      opening_balance_at: parsed.openingBalanceAt ?? null,
      notes: parsed.notes ?? null,
      is_active: true,
    })
    .select('id')
    .single()

  if (error) throw new Error(error.message)

  // Si hay saldo de apertura, creamos un movimiento tipo 'opening'
  if ((parsed.openingBalance ?? 0) !== 0) {
    await supabase.from('iadmin_bank_movements').insert({
      administration_id: administrationId,
      managed_property_id: parsed.propertyId,
      cash_account_id: data.id,
      movement_date: parsed.openingBalanceAt ?? new Date().toISOString().slice(0, 10),
      description: 'Saldo de apertura',
      amount: parsed.openingBalance ?? 0,
      movement_kind: 'opening',
      created_by: profile.id,
    })
  }

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: administrationId,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_cash_accounts',
    entity_id: data.id,
    action: 'cash_account.created',
    metadata: { name: parsed.name, kind: parsed.kind },
  })

  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}/cuentas`)
  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, "layout")
  return { id: data.id as string }
}

const updateAccountSchema = accountFields.partial().extend({
  accountId: z.string().uuid(),
})

export async function updateCashAccount(input: z.input<typeof updateAccountSchema>) {
  const parsed = updateAccountSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: account } = await supabase
    .from('iadmin_cash_accounts')
    .select('id, managed_property_id, iadmin_managed_properties!inner(administration_id)')
    .eq('id', parsed.accountId)
    .maybeSingle()
  if (!account) throw new Error('Cuenta no encontrada')

  const rel = Array.isArray(account.iadmin_managed_properties)
    ? account.iadmin_managed_properties[0]
    : account.iadmin_managed_properties
  const administrationId = rel?.administration_id as string

  const { profile } = await requireIAdmin({ capability: 'cash_accounts.manage', administrationId })

  const patch: Record<string, unknown> = {}
  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.kind !== undefined) patch.kind = parsed.kind
  if (parsed.bankName !== undefined) patch.bank_name = parsed.bankName
  if (parsed.accountNumber !== undefined) patch.account_number = parsed.accountNumber
  if (parsed.cbu !== undefined) patch.cbu = parsed.cbu
  if (parsed.alias !== undefined) patch.alias = parsed.alias
  if (parsed.notes !== undefined) patch.notes = parsed.notes
  if (Object.keys(patch).length === 0) return

  const { error } = await supabase.from('iadmin_cash_accounts').update(patch).eq('id', parsed.accountId)
  if (error) throw new Error(error.message)

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: administrationId,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_cash_accounts',
    entity_id: parsed.accountId,
    action: 'cash_account.updated',
    metadata: patch,
  })

  revalidatePath(`/iadmin/consorcios/${account.managed_property_id}/cuentas`)
  revalidatePath(`/iadmin/consorcios/${account.managed_property_id}`, "layout")
}

const toggleAccountSchema = z.object({
  accountId: z.string().uuid(),
  isActive: z.boolean(),
})

export async function setCashAccountActive(input: z.input<typeof toggleAccountSchema>) {
  const parsed = toggleAccountSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: account } = await supabase
    .from('iadmin_cash_accounts')
    .select('id, managed_property_id, iadmin_managed_properties!inner(administration_id)')
    .eq('id', parsed.accountId)
    .maybeSingle()
  if (!account) throw new Error('Cuenta no encontrada')

  const rel = Array.isArray(account.iadmin_managed_properties)
    ? account.iadmin_managed_properties[0]
    : account.iadmin_managed_properties
  const administrationId = rel?.administration_id as string

  const { profile } = await requireIAdmin({ capability: 'cash_accounts.manage', administrationId })

  const { error } = await supabase
    .from('iadmin_cash_accounts')
    .update({ is_active: parsed.isActive })
    .eq('id', parsed.accountId)
  if (error) throw new Error(error.message)

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: administrationId,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_cash_accounts',
    entity_id: parsed.accountId,
    action: parsed.isActive ? 'cash_account.activated' : 'cash_account.archived',
  })

  revalidatePath(`/iadmin/consorcios/${account.managed_property_id}/cuentas`)
  revalidatePath(`/iadmin/consorcios/${account.managed_property_id}`, "layout")
}

// ----------------------------------------------------------------------------
// Movimientos manuales
// ----------------------------------------------------------------------------

const manualMovementSchema = z.object({
  cashAccountId: z.string().uuid(),
  movementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().min(1).max(240),
  amount: z.number().refine((n) => n !== 0, 'El monto no puede ser 0'),
  externalRef: z.string().trim().max(80).optional(),
  movementKind: z.enum(['manual', 'transfer', 'adjustment']).optional().default('manual'),
})

export async function addManualMovement(input: z.input<typeof manualMovementSchema>) {
  const parsed = manualMovementSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: account } = await supabase
    .from('iadmin_cash_accounts')
    .select('id, managed_property_id, iadmin_managed_properties!inner(administration_id)')
    .eq('id', parsed.cashAccountId)
    .maybeSingle()
  if (!account) throw new Error('Cuenta no encontrada')

  const rel = Array.isArray(account.iadmin_managed_properties)
    ? account.iadmin_managed_properties[0]
    : account.iadmin_managed_properties
  const administrationId = rel?.administration_id as string

  const { profile } = await requireIAdmin({ capability: 'cash_accounts.manage', administrationId })

  const { error } = await supabase.from('iadmin_bank_movements').insert({
    administration_id: administrationId,
    managed_property_id: account.managed_property_id,
    cash_account_id: parsed.cashAccountId,
    movement_date: parsed.movementDate,
    description: parsed.description,
    amount: parsed.amount,
    external_ref: parsed.externalRef ?? null,
    movement_kind: parsed.movementKind ?? 'manual',
    created_by: profile.id,
  })

  if (error) throw new Error(error.message)

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: administrationId,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_bank_movements',
    entity_id: null,
    action: 'movement.created',
    metadata: { amount: parsed.amount, description: parsed.description },
  })

  revalidatePath(`/iadmin/consorcios/${account.managed_property_id}/cuentas`)
  revalidatePath(`/iadmin/consorcios/${account.managed_property_id}`, "layout")
}

// ----------------------------------------------------------------------------
// Marcar gasto como pagado (crea movimiento negativo vinculado al gasto)
// ----------------------------------------------------------------------------

const payExpenseSchema = z.object({
  expenseId: z.string().uuid(),
  cashAccountId: z.string().uuid(),
  movementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  externalRef: z.string().trim().max(80).optional(),
})

export async function payExpense(input: z.input<typeof payExpenseSchema>) {
  const parsed = payExpenseSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: expense } = await supabase
    .from('iadmin_expenses')
    .select('id, administration_id, managed_property_id, amount, description, status')
    .eq('id', parsed.expenseId)
    .maybeSingle()
  if (!expense) throw new Error('Gasto no encontrado')
  if (expense.status === 'draft' || expense.status === 'rejected') {
    throw new Error('No se puede pagar un gasto en estado borrador o rechazado')
  }

  const { profile } = await requireIAdmin({
    capability: 'expenses.mark_paid',
    administrationId: expense.administration_id,
  })

  // Valida que la cuenta pertenezca al mismo consorcio
  const { data: account } = await supabase
    .from('iadmin_cash_accounts')
    .select('id, managed_property_id')
    .eq('id', parsed.cashAccountId)
    .maybeSingle()
  if (!account) throw new Error('Cuenta no encontrada')
  if (account.managed_property_id !== expense.managed_property_id) {
    throw new Error('La cuenta no pertenece al consorcio del gasto')
  }

  // Evita doble pago: si ya hay movimiento para este gasto, fallar
  const { data: existing } = await supabase
    .from('iadmin_bank_movements')
    .select('id')
    .eq('expense_id', parsed.expenseId)
    .eq('movement_kind', 'expense_payment')
    .maybeSingle()
  if (existing) {
    throw new Error('Este gasto ya tiene un pago registrado')
  }

  const { error } = await supabase.from('iadmin_bank_movements').insert({
    administration_id: expense.administration_id,
    managed_property_id: expense.managed_property_id,
    cash_account_id: parsed.cashAccountId,
    movement_date: parsed.movementDate,
    description: `Pago a proveedor: ${expense.description}`,
    amount: -Number(expense.amount), // egreso
    external_ref: parsed.externalRef ?? null,
    movement_kind: 'expense_payment',
    expense_id: parsed.expenseId,
    created_by: profile.id,
  })

  if (error) throw new Error(error.message)

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: expense.administration_id,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_expenses',
    entity_id: parsed.expenseId,
    action: 'expense.paid',
    metadata: { amount: Number(expense.amount), cash_account_id: parsed.cashAccountId },
  })

  revalidatePath(`/iadmin/gastos`)
  revalidatePath(`/iadmin/gastos/${parsed.expenseId}`)
  revalidatePath(`/iadmin/consorcios/${expense.managed_property_id}`, "layout")
  revalidatePath(`/iadmin/consorcios/${expense.managed_property_id}/cuentas`)
}
