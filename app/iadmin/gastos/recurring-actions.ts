'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { findMembership, requireIAdmin } from '@/lib/auth'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import type { IAdminExpenseStatus } from '@/lib/types'

const schema = z.object({
  propertyId: z.string().uuid(),
  periodYear: z.number().int().optional(),
  periodMonth: z.number().int().min(1).max(12).optional(),
})

export type CloneRecurringResult = {
  created: number
  skipped: Array<{ providerName: string; reason: string }>
  totalAmount: number
  expenseIds: string[]
}

/**
 * Clona al periodo indicado (o al del mes en curso) todos los gastos de
 * proveedores marcados como recurrentes del consorcio. Para cada proveedor:
 *  - si hubo un gasto imputed o approved en los 3 meses anteriores, usa ese monto
 *  - sino usa recurring_amount del proveedor
 *  - skip si ya hay un gasto de ese proveedor en el mismo periodo (evita duplicar)
 */
export async function cloneRecurringExpenses(
  input: z.input<typeof schema>,
): Promise<CloneRecurringResult> {
  const parsed = schema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: property } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id')
    .eq('id', parsed.propertyId)
    .maybeSingle()
  if (!property) throw new Error('Consorcio no encontrado')

  const { profile, context } = await requireIAdmin({
    capability: 'expenses.recurring.manage',
    administrationId: property.administration_id,
  })

  const now = new Date()
  const year = parsed.periodYear ?? now.getFullYear()
  const month = parsed.periodMonth ?? now.getMonth() + 1

  // Resolver período: crear si no existe (open)
  let periodId: string
  const { data: existingPeriod } = await supabase
    .from('iadmin_accounting_periods')
    .select('id')
    .eq('managed_property_id', parsed.propertyId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle()
  if (existingPeriod) {
    periodId = existingPeriod.id as string
  } else {
    const { data: np, error: pErr } = await supabase
      .from('iadmin_accounting_periods')
      .insert({
        managed_property_id: parsed.propertyId,
        period_year: year,
        period_month: month,
        status: 'open',
      })
      .select('id')
      .single()
    if (pErr || !np) throw new Error(pErr?.message ?? 'no se pudo crear periodo')
    periodId = np.id as string
  }

  // Proveedores recurrentes de la administración
  const { data: providers } = await supabase
    .from('iadmin_providers')
    .select('id, name, recurring_amount, recurring_kind, default_category')
    .eq('administration_id', property.administration_id)
    .eq('is_recurring', true)
    .eq('is_active', true)

  const providerList = providers ?? []
  if (providerList.length === 0) {
    return { created: 0, skipped: [], totalAmount: 0, expenseIds: [] }
  }

  // Traer gastos existentes del periodo actual + del periodo previo
  const providerIds = providerList.map((p: any) => p.id)
  const { data: existingThisPeriod } = await supabase
    .from('iadmin_expenses')
    .select('provider_id')
    .eq('managed_property_id', parsed.propertyId)
    .eq('accounting_period_id', periodId)
    .in('provider_id', providerIds)

  const existingProviderIds = new Set((existingThisPeriod ?? []).map((e: any) => e.provider_id).filter(Boolean))

  // Ultimo monto conocido por proveedor: miramos los ultimos 3 meses (antes del period actual)
  const fromDate = new Date(year, month - 3 - 1, 1).toISOString().slice(0, 10)
  const { data: historyRows } = await supabase
    .from('iadmin_expenses')
    .select('provider_id, amount, issued_at')
    .eq('managed_property_id', parsed.propertyId)
    .in('provider_id', providerIds)
    .gte('issued_at', fromDate)
    .order('issued_at', { ascending: false })

  const lastAmountByProvider = new Map<string, number>()
  for (const r of historyRows ?? []) {
    if (!r.provider_id) continue
    if (lastAmountByProvider.has(r.provider_id)) continue
    lastAmountByProvider.set(r.provider_id, Number(r.amount))
  }

  // Status inicial
  const canApprove = context.isSuperAdmin || (context.memberships
    .find((m) => m.administration.id === property.administration_id)
    ?.capabilities.includes('expenses.approve') ?? false)
  const initialStatus: IAdminExpenseStatus = canApprove ? 'imputed' : 'pending_review'

  const today = new Date(year, month - 1, 5) // fecha ficticia del 5to del mes
  const issuedAt = today.toISOString().slice(0, 10)

  const result: CloneRecurringResult = { created: 0, skipped: [], totalAmount: 0, expenseIds: [] }

  for (const p of providerList) {
    if (existingProviderIds.has(p.id)) {
      result.skipped.push({ providerName: p.name, reason: 'ya hay un gasto de este proveedor este mes' })
      continue
    }
    const lastAmount = lastAmountByProvider.get(p.id)
    const amount = lastAmount ?? (p.recurring_amount !== null && p.recurring_amount !== undefined ? Number(p.recurring_amount) : null)
    if (amount === null) {
      result.skipped.push({ providerName: p.name, reason: 'sin monto historico ni recurring_amount' })
      continue
    }

    const description = `${p.name} - ${String(month).padStart(2, '0')}/${year}`

    const { data: newExpense, error } = await supabase
      .from('iadmin_expenses')
      .insert({
        administration_id: property.administration_id,
        managed_property_id: parsed.propertyId,
        accounting_period_id: periodId,
        provider_id: p.id,
        category: p.default_category ?? null,
        description,
        amount,
        currency: 'ARS',
        issued_at: issuedAt,
        status: initialStatus,
        expense_kind: p.recurring_kind ?? 'ordinaria',
        created_by: profile.id,
        ...(initialStatus === 'imputed' ? { approved_by: profile.id, approved_at: new Date().toISOString() } : {}),
      })
      .select('id')
      .single()

    if (error || !newExpense) {
      result.skipped.push({ providerName: p.name, reason: error?.message ?? 'insert fail' })
      continue
    }

    result.created += 1
    result.totalAmount += amount
    result.expenseIds.push(newExpense.id as string)
  }

  if (result.created > 0) {
    await supabase.from('iadmin_audit_logs').insert({
      administration_id: property.administration_id,
      actor_profile_id: profile.id,
      entity_type: 'iadmin_managed_properties',
      entity_id: parsed.propertyId,
      action: 'expenses.recurring_cloned',
      metadata: {
        period: `${year}-${String(month).padStart(2, '0')}`,
        created: result.created,
        skipped: result.skipped.length,
        total: Math.round(result.totalAmount * 100) / 100,
      },
    })
  }

  revalidatePath('/iadmin/gastos')
  revalidatePath('/iadmin/cartera')
  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, "layout")

  // Helper para reset de un findMembership ref no usada (limpieza)
  void findMembership

  result.totalAmount = Math.round(result.totalAmount * 100) / 100
  return result
}
