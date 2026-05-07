'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireIAdmin } from '@/lib/auth'
import { getIAdminUnitAccountStatement } from '@/lib/data'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import type { IAdminExpenseStatus, IAdminUnitAccountStatement } from '@/lib/types'

// ----------------------------------------------------------------------------
// upsertMonthlyCell: crear/actualizar/borrar el gasto de 1 celda
// ----------------------------------------------------------------------------

const cellSchema = z.object({
  propertyId: z.string().uuid(),
  providerId: z.string().uuid().nullable(),   // null = gasto sin proveedor
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  amount: z.number().nullable(),               // null o 0 = borrar
  description: z.string().trim().max(240).optional(),
  expenseKind: z.enum(['ordinaria', 'extraordinaria']).optional().default('ordinaria'),
})

export async function upsertMonthlyCell(
  input: z.input<typeof cellSchema>,
): Promise<{ action: 'created' | 'updated' | 'deleted' | 'noop'; expenseId: string | null }> {
  const parsed = cellSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: property } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id')
    .eq('id', parsed.propertyId)
    .maybeSingle()
  if (!property) throw new Error('Consorcio no encontrado')

  const { profile, context } = await requireIAdmin({
    capability: 'expenses.create',
    administrationId: property.administration_id,
  })

  // Resolver período (crear si no existe)
  const { data: existingPeriod } = await supabase
    .from('iadmin_accounting_periods')
    .select('id, status')
    .eq('managed_property_id', parsed.propertyId)
    .eq('period_year', parsed.year)
    .eq('period_month', parsed.month)
    .maybeSingle()

  let periodId: string
  let periodStatus: string
  if (existingPeriod) {
    periodId = existingPeriod.id as string
    periodStatus = existingPeriod.status as string
  } else {
    const { data: np, error: pErr } = await supabase
      .from('iadmin_accounting_periods')
      .insert({
        managed_property_id: parsed.propertyId,
        period_year: parsed.year,
        period_month: parsed.month,
        status: 'open',
      })
      .select('id, status')
      .single()
    if (pErr || !np) throw new Error(pErr?.message ?? 'No se pudo crear el periodo')
    periodId = np.id as string
    periodStatus = np.status as string
  }

  if (periodStatus === 'closed') {
    throw new Error('El período del mes está cerrado. Reabrilo desde Liquidaciones para editar.')
  }

  // Buscar gasto existente para ese (property, provider, period)
  let existingQuery = supabase
    .from('iadmin_expenses')
    .select('id, status')
    .eq('managed_property_id', parsed.propertyId)
    .eq('accounting_period_id', periodId)
  if (parsed.providerId) {
    existingQuery = existingQuery.eq('provider_id', parsed.providerId)
  } else {
    existingQuery = existingQuery.is('provider_id', null)
  }
  const { data: existingList } = await existingQuery

  const existing = existingList && existingList.length === 1 ? existingList[0] : null
  const wantsDelete = parsed.amount === null || parsed.amount === 0

  if (wantsDelete && existing) {
    const { error } = await supabase.from('iadmin_expenses').delete().eq('id', existing.id)
    if (error) throw new Error(error.message)
    await supabase.from('iadmin_audit_logs').insert({
      administration_id: property.administration_id,
      actor_profile_id: profile.id,
      entity_type: 'iadmin_expenses',
      entity_id: existing.id,
      action: 'expense.deleted_from_planilla',
      metadata: { period: `${parsed.year}-${parsed.month}` },
    })
    revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, "layout")
    return { action: 'deleted', expenseId: null }
  }

  if (wantsDelete && !existing) {
    return { action: 'noop', expenseId: null }
  }

  const amount = parsed.amount as number

  // Si el user puede aprobar, imputed directo
  const canApprove = context.isSuperAdmin || (context.memberships
    .find((m) => m.administration.id === property.administration_id)
    ?.capabilities.includes('expenses.approve') ?? false)
  const targetStatus: IAdminExpenseStatus = canApprove ? 'imputed' : 'pending_review'

  // Nombre descriptivo
  let description = parsed.description?.trim() ?? ''
  if (!description) {
    if (parsed.providerId) {
      const { data: provider } = await supabase
        .from('iadmin_providers')
        .select('name, default_description')
        .eq('id', parsed.providerId)
        .maybeSingle()
      description = (provider?.default_description?.trim() || provider?.name || 'Gasto') + ` - ${String(parsed.month).padStart(2, '0')}/${parsed.year}`
    } else {
      description = `Gasto - ${String(parsed.month).padStart(2, '0')}/${parsed.year}`
    }
  }

  if (existing) {
    const { error } = await supabase
      .from('iadmin_expenses')
      .update({
        amount,
        description,
        expense_kind: parsed.expenseKind ?? 'ordinaria',
        status: targetStatus,
        ...(targetStatus === 'imputed' && existing.status !== 'imputed'
          ? { approved_by: profile.id, approved_at: new Date().toISOString() }
          : {}),
      })
      .eq('id', existing.id)
    if (error) throw new Error(error.message)
    revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, "layout")
    return { action: 'updated', expenseId: existing.id as string }
  }

  // Issued date: ultimo dia habil del mes del periodo (default conservador = dia 5)
  const issuedAt = new Date(parsed.year, parsed.month - 1, 5).toISOString().slice(0, 10)

  const { data: inserted, error } = await supabase
    .from('iadmin_expenses')
    .insert({
      administration_id: property.administration_id,
      managed_property_id: parsed.propertyId,
      accounting_period_id: periodId,
      provider_id: parsed.providerId,
      description,
      amount,
      currency: 'ARS',
      issued_at: issuedAt,
      status: targetStatus,
      expense_kind: parsed.expenseKind ?? 'ordinaria',
      created_by: profile.id,
      ...(targetStatus === 'imputed' ? { approved_by: profile.id, approved_at: new Date().toISOString() } : {}),
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)

  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, "layout")
  return { action: 'created', expenseId: inserted.id as string }
}

// ----------------------------------------------------------------------------
// addRecurringRubro: agregar un rubro nuevo a la planilla (crea provider recurrente)
// ----------------------------------------------------------------------------

const addRubroSchema = z.object({
  administrationId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60).optional(),
  recurringKind: z.enum(['ordinaria', 'extraordinaria']).optional().default('ordinaria'),
})

export async function addRecurringRubro(input: z.input<typeof addRubroSchema>): Promise<{ providerId: string }> {
  const parsed = addRubroSchema.parse(input)
  await requireIAdmin({
    capability: 'providers.manage',
    administrationId: parsed.administrationId,
  })

  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // Si ya existe un provider con ese nombre, lo marcamos recurring si no lo era
  const { data: existing } = await supabase
    .from('iadmin_providers')
    .select('id, is_recurring')
    .eq('administration_id', parsed.administrationId)
    .ilike('name', parsed.name.trim())
    .maybeSingle()

  if (existing) {
    if (!existing.is_recurring) {
      await supabase
        .from('iadmin_providers')
        .update({ is_recurring: true, recurring_kind: parsed.recurringKind })
        .eq('id', existing.id)
    }
    revalidatePath('/iadmin/consorcios', 'layout')
    return { providerId: existing.id as string }
  }

  const { data: created, error } = await supabase
    .from('iadmin_providers')
    .insert({
      administration_id: parsed.administrationId,
      name: parsed.name.trim(),
      category: parsed.category ?? null,
      default_category: parsed.category ?? null,
      is_recurring: true,
      recurring_kind: parsed.recurringKind ?? 'ordinaria',
      is_active: true,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)

  revalidatePath('/iadmin/consorcios', 'layout')
  return { providerId: created.id as string }
}

// ----------------------------------------------------------------------------
// addExpenseLine: agrega una línea de gasto (recurrente o eventual) y carga
// su monto del mes en curso en un solo paso. Pensado para la vista
// "Movimientos" simplificada del consorcio.
// ----------------------------------------------------------------------------

const addExpenseLineSchema = z.object({
  propertyId: z.string().uuid(),
  administrationId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  amount: z.number().nonnegative().nullable(),
  kind: z.enum(['ordinaria', 'extraordinaria']).default('ordinaria'),
  isRecurring: z.boolean().default(false),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
})

export async function addExpenseLine(
  input: z.input<typeof addExpenseLineSchema>,
): Promise<{ providerId: string; expenseId: string | null }> {
  const parsed = addExpenseLineSchema.parse(input)
  await requireIAdmin({
    capability: 'providers.manage',
    administrationId: parsed.administrationId,
  })
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // Reusar provider con mismo nombre dentro de la administración si ya existe.
  const { data: existing } = await supabase
    .from('iadmin_providers')
    .select('id, is_recurring')
    .eq('administration_id', parsed.administrationId)
    .ilike('name', parsed.name.trim())
    .maybeSingle()

  let providerId: string
  if (existing) {
    providerId = existing.id as string
    if (parsed.isRecurring && !existing.is_recurring) {
      await supabase
        .from('iadmin_providers')
        .update({ is_recurring: true, recurring_kind: parsed.kind })
        .eq('id', providerId)
    }
  } else {
    const { data: created, error } = await supabase
      .from('iadmin_providers')
      .insert({
        administration_id: parsed.administrationId,
        name: parsed.name.trim(),
        is_recurring: parsed.isRecurring,
        recurring_kind: parsed.kind,
        is_active: true,
      })
      .select('id')
      .single()
    if (error || !created) throw new Error(error?.message ?? 'No se pudo crear el rubro')
    providerId = created.id as string
  }

  let expenseId: string | null = null
  if (parsed.amount !== null && parsed.amount > 0) {
    const result = await upsertMonthlyCell({
      propertyId: parsed.propertyId,
      providerId,
      year: parsed.year,
      month: parsed.month,
      amount: parsed.amount,
      expenseKind: parsed.kind,
    })
    expenseId = result.expenseId
  }

  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, 'layout')
  return { providerId, expenseId }
}

// ----------------------------------------------------------------------------
// replicatePreviousMonth: para cada gasto recurrente con monto en el mes
// anterior, copia ese monto al mes actual si la celda actual está vacía.
// ----------------------------------------------------------------------------

const replicateSchema = z.object({
  propertyId: z.string().uuid(),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
})

export async function replicatePreviousMonth(
  input: z.input<typeof replicateSchema>,
): Promise<{ replicated: number }> {
  const parsed = replicateSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: property } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id')
    .eq('id', parsed.propertyId)
    .maybeSingle()
  if (!property) throw new Error('Consorcio no encontrado')

  await requireIAdmin({
    capability: 'expenses.create',
    administrationId: property.administration_id,
  })

  const prevYear = parsed.month === 1 ? parsed.year - 1 : parsed.year
  const prevMonth = parsed.month === 1 ? 12 : parsed.month - 1

  // Períodos de los dos meses
  const { data: periods } = await supabase
    .from('iadmin_accounting_periods')
    .select('id, period_year, period_month')
    .eq('managed_property_id', parsed.propertyId)
    .in('period_year', [parsed.year, prevYear])
    .in('period_month', [parsed.month, prevMonth])
  const prevPeriod = periods?.find((p) => p.period_year === prevYear && p.period_month === prevMonth)
  const currPeriod = periods?.find((p) => p.period_year === parsed.year && p.period_month === parsed.month)
  if (!prevPeriod) return { replicated: 0 }

  // Gastos del mes anterior (sólo de proveedores recurrentes)
  const { data: prevExpenses } = await supabase
    .from('iadmin_expenses')
    .select('provider_id, amount, expense_kind, iadmin_providers!inner(is_recurring)')
    .eq('managed_property_id', parsed.propertyId)
    .eq('accounting_period_id', prevPeriod.id)
    .not('provider_id', 'is', null)

  type PrevExpenseRow = {
    provider_id: string | null
    amount: number | string | null
    expense_kind: 'ordinaria' | 'extraordinaria' | null
    iadmin_providers: { is_recurring: boolean } | { is_recurring: boolean }[] | null
  }
  const rawPrev = (prevExpenses ?? []) as unknown as PrevExpenseRow[]
  const recurringPrev = rawPrev.filter((e) => {
    const rel = e.iadmin_providers
    if (!rel) return false
    if (Array.isArray(rel)) return rel[0]?.is_recurring === true
    return rel.is_recurring === true
  })
  if (recurringPrev.length === 0) return { replicated: 0 }

  // Gastos del mes actual existentes (para no pisar)
  const existingProviderIds = new Set<string>()
  if (currPeriod) {
    const { data: currExpenses } = await supabase
      .from('iadmin_expenses')
      .select('provider_id')
      .eq('managed_property_id', parsed.propertyId)
      .eq('accounting_period_id', currPeriod.id)
    for (const row of currExpenses ?? []) {
      if (row.provider_id) existingProviderIds.add(row.provider_id as string)
    }
  }

  let replicated = 0
  for (const exp of recurringPrev) {
    const providerId = exp.provider_id as string
    if (existingProviderIds.has(providerId)) continue
    if (!exp.amount || Number(exp.amount) <= 0) continue
    await upsertMonthlyCell({
      propertyId: parsed.propertyId,
      providerId,
      year: parsed.year,
      month: parsed.month,
      amount: Number(exp.amount),
      expenseKind: (exp.expense_kind as 'ordinaria' | 'extraordinaria') ?? 'ordinaria',
    })
    replicated++
  }

  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, 'layout')
  return { replicated }
}

// ----------------------------------------------------------------------------
// emitAndNotify: el boton magico del admin
// ----------------------------------------------------------------------------

const emitSchema = z.object({
  propertyId: z.string().uuid(),
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  extraNote: z.string().trim().max(280).optional(),
})

export type NeighborMessage = {
  itemId: string
  unitCode: string
  holderName: string | null
  holderPhone: string | null
  holderEmail: string | null
  amountToPay: number
  subtotal: number
  message: string
  shareUrl: string | null
  whatsappHref: string | null
}

export type EmitAndNotifyResult = {
  runId: string
  periodLabel: string
  liquidated: number
  neighbors: NeighborMessage[]
}

function randomToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function formatARS(n: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)
}

// ----------------------------------------------------------------------------
// quickPayFromMesa: cobra el saldo de una unidad del run actual con 1 click
// ----------------------------------------------------------------------------

const quickPaySchema = z.object({
  propertyId: z.string().uuid(),
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  unitId: z.string().uuid(),
  amount: z.number().positive(),
})

function _randomToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function quickPayFromMesa(input: z.input<typeof quickPaySchema>): Promise<{ receiptNumber: string }> {
  const parsed = quickPaySchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: property } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id')
    .eq('id', parsed.propertyId)
    .maybeSingle()
  if (!property) throw new Error('Consorcio no encontrado')

  const { profile } = await requireIAdmin({
    capability: 'collections.register',
    administrationId: property.administration_id,
  })

  const { data: period } = await supabase
    .from('iadmin_accounting_periods')
    .select('id')
    .eq('managed_property_id', parsed.propertyId)
    .eq('period_year', parsed.year)
    .eq('period_month', parsed.month)
    .maybeSingle()
  if (!period) throw new Error('Período no encontrado')

  const { data: run } = await supabase
    .from('iadmin_liquidation_runs')
    .select('id')
    .eq('managed_property_id', parsed.propertyId)
    .eq('accounting_period_id', period.id)
    .maybeSingle()
  if (!run) throw new Error('No hay liquidación emitida para este mes')

  const { data: item } = await supabase
    .from('iadmin_liquidation_items')
    .select('id')
    .eq('liquidation_run_id', run.id)
    .eq('unit_id', parsed.unitId)
    .maybeSingle()
  if (!item) throw new Error('Unidad sin item en la liquidación')

  const { data: cashAccount } = await supabase
    .from('iadmin_cash_accounts')
    .select('id, name')
    .eq('managed_property_id', parsed.propertyId)
    .eq('is_active', true)
    .order('created_at')
    .limit(1)
    .maybeSingle()
  if (!cashAccount) throw new Error('Configurá una cuenta bancaria antes de cobrar')

  const today = new Date().toISOString().slice(0, 10)
  const { data: movement, error: movError } = await supabase
    .from('iadmin_bank_movements')
    .insert({
      administration_id: property.administration_id,
      managed_property_id: parsed.propertyId,
      cash_account_id: cashAccount.id,
      movement_date: today,
      description: 'Cobranza',
      amount: parsed.amount,
      movement_kind: 'collection',
      created_by: profile.id,
    })
    .select('id')
    .single()
  if (movError) throw new Error(movError.message)

  const { data: receipt, error: receiptError } = await supabase.rpc('iadmin_next_receipt_number', {
    admin_id: property.administration_id,
  })
  if (receiptError) throw new Error(receiptError.message)

  const { error } = await supabase.from('iadmin_payments').insert({
    administration_id: property.administration_id,
    managed_property_id: parsed.propertyId,
    liquidation_run_id: run.id,
    liquidation_item_id: item.id,
    unit_id: parsed.unitId,
    cash_account_id: cashAccount.id,
    bank_movement_id: movement.id,
    amount: parsed.amount,
    paid_at: today,
    method: 'transferencia',
    receipt_number: receipt,
    created_by: profile.id,
  })
  if (error) {
    await supabase.from('iadmin_bank_movements').delete().eq('id', movement.id)
    throw new Error(error.message)
  }

  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, "layout")
  return { receiptNumber: receipt as string }
}

export async function emitAndNotify(
  input: z.input<typeof emitSchema>,
): Promise<EmitAndNotifyResult> {
  const parsed = emitSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: property } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id, display_name, buildings(name), iadmin_administrations(name, legal_info)')
    .eq('id', parsed.propertyId)
    .maybeSingle()
  if (!property) throw new Error('Consorcio no encontrado')

  const { profile } = await requireIAdmin({
    capability: 'liquidations.create',
    administrationId: property.administration_id,
  })

  // 1. Asegurar que existe el periodo
  const { data: period } = await supabase
    .from('iadmin_accounting_periods')
    .select('id, status')
    .eq('managed_property_id', parsed.propertyId)
    .eq('period_year', parsed.year)
    .eq('period_month', parsed.month)
    .maybeSingle()
  if (!period) throw new Error('El período no existe. Cargá al menos un gasto primero.')

  // 2. Asegurar que hay gastos imputados
  const { data: imputedExpenses } = await supabase
    .from('iadmin_expenses')
    .select('id, amount, expense_kind')
    .eq('managed_property_id', parsed.propertyId)
    .eq('accounting_period_id', period.id)
    .eq('status', 'imputed')
  if (!imputedExpenses || imputedExpenses.length === 0) {
    throw new Error('No hay gastos imputados este mes. Cargá al menos uno en la planilla.')
  }

  const ordinaryTotal = imputedExpenses
    .filter((e: any) => (e.expense_kind ?? 'ordinaria') !== 'extraordinaria')
    .reduce((s, e) => s + Number(e.amount), 0)
  const extraordinaryTotal = imputedExpenses
    .filter((e: any) => e.expense_kind === 'extraordinaria')
    .reduce((s, e) => s + Number(e.amount), 0)
  const totalExpenses = Math.round((ordinaryTotal + extraordinaryTotal) * 100) / 100

  // 3. Traer unidades activas con alícuota.
  // Sólo incluímos `iadmin_unit_holders` acá. El contacto del propietario
  // registrado en Citify (vía `unit_profile_memberships`) lo cargamos
  // aparte abajo, en una query independiente, para no acoplar fallas de
  // RLS de esa tabla con la lectura básica de las unidades.
  const { data: unitsData } = await supabase
    .from('iadmin_units')
    .select('id, code, prorata_coefficient, iadmin_unit_holders(full_name, phone, email, is_active)')
    .eq('managed_property_id', parsed.propertyId)
    .eq('is_active', true)
    .order('code')

  const eligibleUnits = (unitsData ?? []).filter((u: any) => u.prorata_coefficient !== null)
  if (eligibleUnits.length === 0) {
    throw new Error('No hay unidades activas con alícuota definida.')
  }

  // Cargar contacto del propietario registrado en Citify por unidad.
  // Si esta query falla por RLS, simplemente no enriquecemos y seguimos
  // usando los datos de iadmin_unit_holders.
  type OwnerContact = { fullName: string | null; phone: string | null; email: string | null }
  const ownerByUnit = new Map<string, OwnerContact>()
  try {
    const unitIds = eligibleUnits.map((u: any) => u.id as string)
    const { data: memberships } = await supabase
      .from('unit_profile_memberships')
      .select('unit_id, relationship_type, active, is_primary, profiles(full_name, email, phone)')
      .in('unit_id', unitIds)
      .eq('relationship_type', 'propietario')
      .eq('active', true)
    for (const m of memberships ?? []) {
      const unitId = (m as any).unit_id as string
      if (ownerByUnit.has(unitId) && !(m as any).is_primary) continue
      const prof = Array.isArray((m as any).profiles) ? (m as any).profiles[0] : (m as any).profiles
      if (!prof) continue
      ownerByUnit.set(unitId, {
        fullName: (prof.full_name ?? '').trim() || null,
        phone: (prof.phone ?? '').trim() || null,
        email: (prof.email ?? '').trim() || null,
      })
    }
  } catch {
    // Silencioso a propósito: no romper el flujo si esta lookup falla.
  }

  // 4. Saldo anterior por unidad
  const previousBalanceByUnit = new Map<string, number>()
  const { data: priorRuns } = await supabase
    .from('iadmin_liquidation_runs')
    .select(`
      id, accounting_period_id,
      iadmin_liquidation_items(id, unit_id, ordinary_amount, extraordinary_amount, previous_balance)
    `)
    .eq('managed_property_id', parsed.propertyId)
    .neq('accounting_period_id', period.id)
    .in('status', ['calculated', 'issued', 'closed'])
    .order('generated_at', { ascending: false })
    .limit(1)

  const priorRun = priorRuns?.[0] ?? null
  if (priorRun) {
    const priorItems = Array.isArray(priorRun.iadmin_liquidation_items) ? priorRun.iadmin_liquidation_items : []
    const priorItemIds = priorItems.map((it: any) => it.id)
    const paidByItem = new Map<string, number>()
    if (priorItemIds.length > 0) {
      const { data: priorPayments } = await supabase
        .from('iadmin_payments')
        .select('liquidation_item_id, amount')
        .in('liquidation_item_id', priorItemIds)
        .eq('is_void', false)
      for (const p of priorPayments ?? []) {
        if (!p.liquidation_item_id) continue
        paidByItem.set(p.liquidation_item_id, (paidByItem.get(p.liquidation_item_id) ?? 0) + Number(p.amount))
      }
    }
    for (const it of priorItems) {
      const sub =
        Number(it.ordinary_amount ?? 0) + Number(it.extraordinary_amount ?? 0) + Number(it.previous_balance ?? 0)
      const paid = paidByItem.get(it.id) ?? 0
      const debt = Math.max(0, Math.round((sub - paid) * 100) / 100)
      if (debt > 0) previousBalanceByUnit.set(it.unit_id, debt)
    }
  }
  const totalPreviousBalance = Array.from(previousBalanceByUnit.values()).reduce((s, v) => s + v, 0)

  // 5. Vencimientos por default
  const nextMonth = parsed.month === 12 ? 1 : parsed.month + 1
  const nextYear = parsed.month === 12 ? parsed.year + 1 : parsed.year
  const mm = String(nextMonth).padStart(2, '0')
  const dueDates = [
    { label: '1er vencimiento', date: `${nextYear}-${mm}-10`, surcharge_pct: 0 },
    { label: '2do vencimiento', date: `${nextYear}-${mm}-25`, surcharge_pct: 3 },
  ]

  // 6. Crear / actualizar run
  const { data: run, error: runError } = await supabase
    .from('iadmin_liquidation_runs')
    .upsert(
      {
        administration_id: property.administration_id,
        managed_property_id: parsed.propertyId,
        accounting_period_id: period.id,
        status: 'issued',
        total_expenses: totalExpenses,
        ordinary_total: Math.round(ordinaryTotal * 100) / 100,
        extraordinary_total: Math.round(extraordinaryTotal * 100) / 100,
        previous_balance: Math.round(totalPreviousBalance * 100) / 100,
        due_dates: dueDates,
        total_units: eligibleUnits.length,
        generated_by: profile.id,
        generated_at: new Date().toISOString(),
        issued_by: profile.id,
        issued_at: new Date().toISOString(),
        closed_by: null,
        closed_at: null,
      },
      { onConflict: 'managed_property_id,accounting_period_id' },
    )
    .select('id')
    .single()
  if (runError) throw new Error(runError.message)

  // 7. Borrar items viejos y re-crear
  await supabase.from('iadmin_liquidation_items').delete().eq('liquidation_run_id', run.id)
  const items = eligibleUnits.map((u: any) => {
    const prorata = Number(u.prorata_coefficient)
    const ordinary = Math.round(ordinaryTotal * prorata * 100) / 100
    const extra = Math.round(extraordinaryTotal * prorata * 100) / 100
    const prev = previousBalanceByUnit.get(u.id) ?? 0
    return {
      liquidation_run_id: run.id,
      unit_id: u.id,
      prorata_coefficient: prorata,
      amount: ordinary,
      ordinary_amount: ordinary,
      extraordinary_amount: extra,
      previous_balance: prev,
    }
  })
  const { error: itemsError } = await supabase.from('iadmin_liquidation_items').insert(items).select('id, unit_id')
  if (itemsError) throw new Error(itemsError.message)

  // 8. Relevar los items ya con su ID para mapear por unit_id
  const { data: newItems } = await supabase
    .from('iadmin_liquidation_items')
    .select('id, unit_id, ordinary_amount, extraordinary_amount, previous_balance')
    .eq('liquidation_run_id', run.id)

  // 9. Generar share tokens para cada item (revocar existentes)
  const itemIds = (newItems ?? []).map((it: any) => it.id)
  if (itemIds.length > 0) {
    await supabase
      .from('iadmin_item_share_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .in('liquidation_item_id', itemIds)
      .is('revoked_at', null)

    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    const inserts = itemIds.map((id: string) => ({
      liquidation_item_id: id,
      token: randomToken(),
      expires_at: expiresAt,
      created_by: profile.id,
    }))
    await supabase.from('iadmin_item_share_tokens').insert(inserts)
  }

  // 10. Armar mensajes por vecino
  const { data: tokenRows } = await supabase
    .from('iadmin_item_share_tokens')
    .select('token, liquidation_item_id')
    .in('liquidation_item_id', itemIds)
    .is('revoked_at', null)
  const tokenByItem = new Map<string, string>()
  for (const t of tokenRows ?? []) tokenByItem.set(t.liquidation_item_id, t.token)

  const adminRow = Array.isArray(property.iadmin_administrations) ? property.iadmin_administrations[0] : property.iadmin_administrations
  const adminLegal = (adminRow?.legal_info ?? {}) as any
  const building = Array.isArray(property.buildings) ? property.buildings[0] : property.buildings
  const propertyName = property.display_name ?? building?.name ?? 'Consorcio'
  const monthLabel = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][parsed.month - 1]
  const periodLabelShort = `${String(parsed.month).padStart(2, '0')}/${parsed.year}`

  const base = process.env.NEXT_PUBLIC_APP_BASE_URL ?? ''

  // Fallback de datos bancarios: si la administración no tiene cargado CBU/alias
  // en legal_info.bank, usamos la cuenta bancaria activa del consorcio.
  let bankCbu: string | null = adminLegal.bank?.cbu ?? null
  let bankAlias: string | null = adminLegal.bank?.alias ?? null
  if (!bankCbu && !bankAlias) {
    const { data: fallbackAccounts } = await supabase
      .from('iadmin_cash_accounts')
      .select('cbu, alias, kind, is_active')
      .eq('managed_property_id', parsed.propertyId)
      .eq('is_active', true)
    const primary = (fallbackAccounts ?? []).find((a: { kind: string }) => a.kind === 'bank')
      ?? (fallbackAccounts ?? [])[0]
    if (primary) {
      bankCbu = (primary.cbu as string | null) ?? null
      bankAlias = (primary.alias as string | null) ?? null
    }
  }

  const neighbors: NeighborMessage[] = eligibleUnits.map((u: any) => {
    const item = (newItems ?? []).find((i: any) => i.unit_id === u.id)
    const itemId = item?.id as string

    // Resolver contacto del vecino con esta prioridad (campo a campo):
    //   1. Propietario activo registrado en Citify (cargado en ownerByUnit)
    //   2. Holder cargado a mano por el admin (iadmin_unit_holders)
    const owner = ownerByUnit.get(u.id) ?? null
    const holders = Array.isArray(u.iadmin_unit_holders) ? u.iadmin_unit_holders : []
    const holder = holders.find((h: any) => h?.is_active) ?? holders[0] ?? null

    const contactName: string | null =
      (owner?.fullName ?? '').trim() || (holder?.full_name ?? '').trim() || null
    const contactPhone: string | null =
      (owner?.phone ?? '').trim() || (holder?.phone ?? '').trim() || null
    const contactEmail: string | null =
      (owner?.email ?? '').trim() || (holder?.email ?? '').trim() || null

    const subtotal =
      Number(item?.ordinary_amount ?? 0) + Number(item?.extraordinary_amount ?? 0) + Number(item?.previous_balance ?? 0)
    const token = tokenByItem.get(itemId) ?? null
    const shareUrl = token ? `${base}/l/${token}` : null

    const bankLine = bankCbu || bankAlias
      ? `\nPara transferir: ${bankCbu ? `CBU ${bankCbu}` : ''}${bankCbu && bankAlias ? ' · ' : ''}${bankAlias ? `Alias ${bankAlias}` : ''}`
      : ''

    const noteLine = parsed.extraNote ? `\n\n${parsed.extraNote}` : ''
    const message = `Hola ${contactName ?? 'vecino/a'}! Ya está la liquidación de ${monthLabel} de ${propertyName}. Tu unidad ${u.code} debe pagar ${formatARS(subtotal)} con vencimiento el ${dueDates[0].date}.${bankLine}${shareUrl ? `\nDetalle: ${shareUrl}` : ''}${noteLine}`

    const phone = (contactPhone ?? '').replace(/[^\d+]/g, '')
    const whatsappBase = phone ? `https://wa.me/${phone.startsWith('+') ? phone.slice(1) : phone}` : 'https://wa.me'
    const whatsappHref = `${whatsappBase}?text=${encodeURIComponent(message)}`

    return {
      itemId,
      unitCode: u.code,
      holderName: contactName,
      holderPhone: contactPhone,
      holderEmail: contactEmail,
      amountToPay: Math.round(subtotal * 100) / 100,
      subtotal: Math.round(subtotal * 100) / 100,
      message,
      shareUrl,
      whatsappHref,
    }
  })

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: property.administration_id,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_liquidation_runs',
    entity_id: run.id,
    action: 'liquidation.emitted_from_planilla',
    metadata: { period: periodLabelShort, neighbors: neighbors.length, total: totalExpenses },
  })

  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, "layout")
  revalidatePath(`/iadmin/liquidaciones/${run.id}`)

  return {
    runId: run.id as string,
    periodLabel: periodLabelShort,
    liquidated: totalExpenses,
    neighbors,
  }
}

// ----------------------------------------------------------------------------
// getExpenseDocumentSignedUrl: abrir el PDF/imagen de una factura desde la Mesa
// ----------------------------------------------------------------------------

const signedDocSchema = z.object({
  documentId: z.string().uuid(),
})

export async function getExpenseDocumentSignedUrl(
  input: z.input<typeof signedDocSchema>,
): Promise<{ url: string; fileName: string }> {
  const parsed = signedDocSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // Traer el documento + gasto + administration para chequear capability
  const { data: doc, error } = await supabase
    .from('iadmin_expense_documents')
    .select('id, storage_path, file_name, iadmin_expenses(id, administration_id, managed_property_id)')
    .eq('id', parsed.documentId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!doc) throw new Error('Documento no encontrado')

  const expense = Array.isArray(doc.iadmin_expenses) ? doc.iadmin_expenses[0] : doc.iadmin_expenses
  if (!expense) throw new Error('Gasto no encontrado')

  await requireIAdmin({
    capability: 'expenses.view',
    administrationId: expense.administration_id as string,
  })

  const { data: signed, error: signError } = await supabase.storage
    .from('iadmin-expense-documents')
    .createSignedUrl(doc.storage_path as string, 300) // 5 minutos

  if (signError || !signed?.signedUrl) throw new Error(signError?.message ?? 'No se pudo generar URL')

  return {
    url: signed.signedUrl,
    fileName: (doc.file_name as string) ?? 'documento',
  }
}

// ----------------------------------------------------------------------------
// getUnitStatement: estado de cuenta del vecino para el drawer
// ----------------------------------------------------------------------------

const statementSchema = z.object({
  propertyId: z.string().uuid(),
  unitId: z.string().uuid(),
  monthsCount: z.number().int().min(1).max(24).optional(),
})

export async function getUnitStatement(
  input: z.input<typeof statementSchema>,
): Promise<IAdminUnitAccountStatement> {
  const parsed = statementSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // Resolver administrationId para chequear capability
  const { data: prop } = await supabase
    .from('iadmin_managed_properties')
    .select('administration_id')
    .eq('id', parsed.propertyId)
    .maybeSingle()
  if (!prop?.administration_id) throw new Error('Consorcio no encontrado')

  await requireIAdmin({
    capability: 'collections.view',
    administrationId: prop.administration_id as string,
  })

  const statement = await getIAdminUnitAccountStatement(parsed.propertyId, parsed.unitId, {
    monthsCount: parsed.monthsCount,
  })
  if (!statement) throw new Error('Unidad no encontrada')
  return statement
}
