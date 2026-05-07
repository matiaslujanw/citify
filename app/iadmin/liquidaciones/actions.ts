'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { findMembership, requireIAdmin } from '@/lib/auth'
import { canLiquidationTransition } from '@/lib/iadmin/liquidation-status'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import type { IAdminCapability, IAdminLiquidationStatus } from '@/lib/types'

async function fetchRunWithAdmin(supabase: any, runId: string) {
  const { data } = await supabase
    .from('iadmin_liquidation_runs')
    .select('id, status, administration_id, managed_property_id, accounting_period_id')
    .eq('id', runId)
    .maybeSingle()
  if (!data) throw new Error('Corrida de liquidacion no encontrada')
  return data as {
    id: string
    status: IAdminLiquidationStatus
    administration_id: string
    managed_property_id: string
    accounting_period_id: string
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function defaultDueDates(periodYear: number, periodMonth: number) {
  // Vencimientos por default: 10 del mes siguiente (0%) y 25 del mes siguiente (3%)
  const nextMonth = periodMonth === 12 ? 1 : periodMonth + 1
  const nextYear = periodMonth === 12 ? periodYear + 1 : periodYear
  const mm = String(nextMonth).padStart(2, '0')
  return [
    { label: '1er vencimiento', date: `${nextYear}-${mm}-10`, surcharge_pct: 0 },
    { label: '2do vencimiento', date: `${nextYear}-${mm}-25`, surcharge_pct: 3 },
  ]
}

// ----------------------------------------------------------------------------
// Generar / recalcular
// ----------------------------------------------------------------------------

const dueDateInput = z.object({
  label: z.string().min(1).max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  surcharge_pct: z.number().min(0).max(100),
})

const generateSchema = z.object({
  propertyId: z.string().uuid(),
  accountingPeriodId: z.string().uuid(),
  dueDates: z.array(dueDateInput).max(6).optional(),
})

export async function generateLiquidationRun(input: z.input<typeof generateSchema>) {
  const parsed = generateSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: property } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id')
    .eq('id', parsed.propertyId)
    .maybeSingle()
  if (!property) throw new Error('Consorcio no encontrado')

  const { data: period } = await supabase
    .from('iadmin_accounting_periods')
    .select('id, managed_property_id, status, period_year, period_month')
    .eq('id', parsed.accountingPeriodId)
    .maybeSingle()
  if (!period) throw new Error('Periodo contable no encontrado')
  if (period.managed_property_id !== parsed.propertyId) {
    throw new Error('El periodo no pertenece al consorcio indicado')
  }

  const { profile } = await requireIAdmin({
    capability: 'liquidations.create',
    administrationId: property.administration_id,
  })

  const { data: existingRun } = await supabase
    .from('iadmin_liquidation_runs')
    .select('id, status')
    .eq('managed_property_id', parsed.propertyId)
    .eq('accounting_period_id', parsed.accountingPeriodId)
    .maybeSingle()

  if (existingRun && (existingRun.status === 'issued' || existingRun.status === 'closed')) {
    throw new Error(
      `Ya existe una liquidacion ${existingRun.status}. Reabri primero para poder recalcular.`,
    )
  }

  // Gastos imputados separados por kind
  const { data: expensesRows, error: expensesError } = await supabase
    .from('iadmin_expenses')
    .select('id, amount, expense_kind')
    .eq('managed_property_id', parsed.propertyId)
    .eq('accounting_period_id', parsed.accountingPeriodId)
    .eq('status', 'imputed')

  if (expensesError) throw new Error(expensesError.message)

  let ordinaryTotal = 0
  let extraordinaryTotal = 0
  for (const e of expensesRows ?? []) {
    const amt = Number(e.amount)
    if ((e.expense_kind ?? 'ordinaria') === 'extraordinaria') {
      extraordinaryTotal += amt
    } else {
      ordinaryTotal += amt
    }
  }
  ordinaryTotal = round2(ordinaryTotal)
  extraordinaryTotal = round2(extraordinaryTotal)
  const totalExpenses = round2(ordinaryTotal + extraordinaryTotal)

  // Unidades activas con alicuota
  const { data: unitsRows, error: unitsError } = await supabase
    .from('iadmin_units')
    .select('id, code, prorata_coefficient')
    .eq('managed_property_id', parsed.propertyId)
    .eq('is_active', true)
    .order('code')

  if (unitsError) throw new Error(unitsError.message)

  const eligibleUnits = (unitsRows ?? []).filter((u: any) => u.prorata_coefficient !== null)
  if (eligibleUnits.length === 0) {
    throw new Error('No hay unidades activas con alicuota definida. Cargalas antes de liquidar.')
  }

  // Saldos previos por unidad: tomamos la ultima run previa (no la actual) del mismo
  // consorcio y calculamos subtotal - cobrado por unidad. Eso se arrastra como
  // previous_balance en el nuevo run.
  const previousBalanceByUnit = new Map<string, number>()
  const { data: priorRuns } = await supabase
    .from('iadmin_liquidation_runs')
    .select(`
      id,
      accounting_period_id,
      iadmin_liquidation_items ( id, unit_id, ordinary_amount, extraordinary_amount, previous_balance )
    `)
    .eq('managed_property_id', parsed.propertyId)
    .neq('id', existingRun?.id ?? '00000000-0000-0000-0000-000000000000')
    .in('status', ['calculated', 'issued', 'closed'])
    .order('generated_at', { ascending: false })
    .limit(1)

  const priorRun = priorRuns?.[0] ?? null

  if (priorRun) {
    const priorItems = Array.isArray(priorRun.iadmin_liquidation_items) ? priorRun.iadmin_liquidation_items : []
    const itemIds = priorItems.map((it: any) => it.id as string)

    // Pagos vivos contra esos items
    const paidByItem = new Map<string, number>()
    if (itemIds.length > 0) {
      const { data: priorPayments } = await supabase
        .from('iadmin_payments')
        .select('liquidation_item_id, amount')
        .in('liquidation_item_id', itemIds)
        .eq('is_void', false)
      for (const p of priorPayments ?? []) {
        if (!p.liquidation_item_id) continue
        const key = p.liquidation_item_id as string
        paidByItem.set(key, (paidByItem.get(key) ?? 0) + Number(p.amount))
      }
    }

    for (const it of priorItems) {
      const subtotal =
        Number(it.ordinary_amount ?? 0) +
        Number(it.extraordinary_amount ?? 0) +
        Number(it.previous_balance ?? 0)
      const paid = paidByItem.get(it.id as string) ?? 0
      const debt = Math.max(0, round2(subtotal - paid))
      if (debt > 0) {
        previousBalanceByUnit.set(it.unit_id as string, debt)
      }
    }
  }

  // Vencimientos
  const dueDates = parsed.dueDates && parsed.dueDates.length > 0
    ? parsed.dueDates
    : defaultDueDates(period.period_year, period.period_month)

  const totalPreviousBalance = round2(
    Array.from(previousBalanceByUnit.values()).reduce((s, v) => s + v, 0),
  )

  const runPayload = {
    administration_id: property.administration_id,
    managed_property_id: parsed.propertyId,
    accounting_period_id: parsed.accountingPeriodId,
    status: 'calculated' as IAdminLiquidationStatus,
    total_expenses: totalExpenses,
    ordinary_total: ordinaryTotal,
    extraordinary_total: extraordinaryTotal,
    previous_balance: totalPreviousBalance,
    due_dates: dueDates,
    total_units: eligibleUnits.length,
    generated_by: profile.id,
    generated_at: new Date().toISOString(),
    issued_by: null,
    issued_at: null,
    closed_by: null,
    closed_at: null,
  }

  const { data: run, error: runError } = await supabase
    .from('iadmin_liquidation_runs')
    .upsert(runPayload, { onConflict: 'managed_property_id,accounting_period_id' })
    .select('id')
    .single()

  if (runError) throw new Error(runError.message)

  // Rehacer items
  await supabase.from('iadmin_liquidation_items').delete().eq('liquidation_run_id', run.id)

  const items = eligibleUnits.map((u: any) => {
    const prorata = Number(u.prorata_coefficient)
    const ordinary = round2(ordinaryTotal * prorata)
    const extraordinary = round2(extraordinaryTotal * prorata)
    const prev = round2(previousBalanceByUnit.get(u.id) ?? 0)
    return {
      liquidation_run_id: run.id,
      unit_id: u.id,
      prorata_coefficient: prorata,
      amount: ordinary, // compat con campo legacy
      ordinary_amount: ordinary,
      extraordinary_amount: extraordinary,
      previous_balance: prev,
    }
  })

  if (items.length > 0) {
    const { error: insertError } = await supabase.from('iadmin_liquidation_items').insert(items)
    if (insertError) throw new Error(insertError.message)
  }

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: property.administration_id,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_liquidation_runs',
    entity_id: run.id,
    action: 'liquidation.calculated',
    metadata: {
      period: `${period.period_year}-${String(period.period_month).padStart(2, '0')}`,
      ordinary_total: ordinaryTotal,
      extraordinary_total: extraordinaryTotal,
      total_units: eligibleUnits.length,
      expenses_count: (expensesRows ?? []).length,
    },
  })

  revalidatePath('/iadmin/liquidaciones')
  revalidatePath(`/iadmin/liquidaciones/${run.id}`)
  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, "layout")

  return {
    id: run.id as string,
    ordinaryTotal,
    extraordinaryTotal,
    totalUnits: eligibleUnits.length,
  }
}

// ----------------------------------------------------------------------------
// Cambio de estado
// ----------------------------------------------------------------------------

const transitionSchema = z.object({
  runId: z.string().uuid(),
  nextStatus: z.enum(['draft', 'calculated', 'issued', 'closed']),
})

export async function changeLiquidationStatus(input: z.input<typeof transitionSchema>) {
  const parsed = transitionSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const run = await fetchRunWithAdmin(supabase, parsed.runId)
  const { profile, context } = await requireIAdmin({ capability: 'liquidations.view' })

  if (!context.isSuperAdmin) {
    const membership = findMembership(context, run.administration_id)
    const capabilities: ReadonlySet<IAdminCapability> = new Set(membership?.capabilities ?? [])
    if (!canLiquidationTransition(run.status, parsed.nextStatus, capabilities)) {
      throw new Error('Transicion no permitida para tu rol')
    }
  }

  const patch: Record<string, unknown> = { status: parsed.nextStatus }
  if (parsed.nextStatus === 'issued') {
    patch.issued_at = new Date().toISOString()
    patch.issued_by = profile.id
  }
  if (parsed.nextStatus === 'closed') {
    patch.closed_at = new Date().toISOString()
    patch.closed_by = profile.id
  } else {
    patch.closed_at = null
    patch.closed_by = null
  }
  if (parsed.nextStatus === 'calculated' || parsed.nextStatus === 'draft') {
    patch.issued_at = null
    patch.issued_by = null
  }

  const { error } = await supabase.from('iadmin_liquidation_runs').update(patch).eq('id', parsed.runId)
  if (error) throw new Error(error.message)

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: run.administration_id,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_liquidation_runs',
    entity_id: parsed.runId,
    action: `liquidation.${parsed.nextStatus}`,
  })

  revalidatePath('/iadmin/liquidaciones')
  revalidatePath(`/iadmin/liquidaciones/${parsed.runId}`)
  revalidatePath(`/iadmin/consorcios/${run.managed_property_id}`, "layout")
}
