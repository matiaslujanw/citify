'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireIAdmin } from '@/lib/auth'
import { enqueueUserNotification } from '@/lib/notifications'
import { getSupabaseServerClient } from '@/lib/supabase/server'

const decisionSchema = z.object({
  receiptId: z.string().uuid(),
  reviewNotes: z.string().trim().max(500).optional(),
})

export async function approvePaymentReceipt(
  input: z.input<typeof decisionSchema>,
): Promise<{ paymentId: string }> {
  const parsed = decisionSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // Cargar el comprobante + item + run para validar y completar campos
  const { data: receipt } = await supabase
    .from('iadmin_payment_receipts')
    .select(
      'id, liquidation_item_id, amount, paid_at, method, reference, status, payment_id, submitted_by_profile_id, iadmin_liquidation_items!inner(id, unit_id, liquidation_run_id, iadmin_units!inner(code), iadmin_liquidation_runs!inner(id, administration_id, managed_property_id, accounting_period_id, period_year, period_month))',
    )
    .eq('id', parsed.receiptId)
    .maybeSingle()
  if (!receipt) throw new Error('Comprobante no encontrado')
  if (receipt.status !== 'pending') throw new Error('Este comprobante ya fue procesado')

  const itemRel = Array.isArray(receipt.iadmin_liquidation_items)
    ? receipt.iadmin_liquidation_items[0]
    : receipt.iadmin_liquidation_items
  if (!itemRel) throw new Error('No se pudo resolver la liquidación asociada')
  const runRel = Array.isArray(itemRel.iadmin_liquidation_runs)
    ? itemRel.iadmin_liquidation_runs[0]
    : itemRel.iadmin_liquidation_runs
  if (!runRel) throw new Error('No se pudo resolver la corrida asociada')

  const administrationId = runRel.administration_id as string
  const managedPropertyId = runRel.managed_property_id as string
  const liquidationRunId = runRel.id as string
  const liquidationItemId = itemRel.id as string
  const unitId = itemRel.unit_id as string

  const { profile } = await requireIAdmin({
    capability: 'collections.register',
    administrationId,
  })

  // Crear el pago real
  const { data: payment, error: payErr } = await supabase
    .from('iadmin_payments')
    .insert({
      liquidation_item_id: liquidationItemId,
      unit_id: unitId,
      administration_id: administrationId,
      managed_property_id: managedPropertyId,
      liquidation_run_id: liquidationRunId,
      amount: receipt.amount,
      paid_at: new Date(receipt.paid_at as string).toISOString(),
      method: receipt.method ?? 'transferencia',
      reference: receipt.reference ?? null,
      notes: 'Origen: comprobante reportado por propietario',
      created_by: profile.id,
    })
    .select('id')
    .single()
  if (payErr || !payment) throw new Error(payErr?.message ?? 'No se pudo registrar el pago')

  // Marcar comprobante como aprobado y vincular
  const { error: upErr } = await supabase
    .from('iadmin_payment_receipts')
    .update({
      status: 'approved',
      reviewed_by_profile_id: profile.id,
      reviewed_at: new Date().toISOString(),
      review_notes: parsed.reviewNotes ?? null,
      payment_id: payment.id,
    })
    .eq('id', parsed.receiptId)
  if (upErr) throw new Error(upErr.message)

  // Notificar al propietario que reportó el pago.
  try {
    const submitterId = (receipt as any).submitted_by_profile_id as string | null
    const unitCode = (Array.isArray(itemRel.iadmin_units) ? itemRel.iadmin_units[0] : (itemRel as any).iadmin_units)?.code
    const period = `${String(runRel.period_month).padStart(2, '0')}/${runRel.period_year}`
    if (submitterId) {
      await enqueueUserNotification({
        recipientProfileId: submitterId,
        kind: 'payment_receipt_approved',
        title: 'Tu pago fue aprobado',
        body: `El admin aprobó tu comprobante por ${formatARSCompact(Number(receipt.amount))} de la unidad ${unitCode ?? ''} (${period}).`.trim(),
        link: '/propietario',
        liquidationRunId,
        liquidationItemId,
        paymentReceiptId: parsed.receiptId,
      })
    }
  } catch {
    // no bloqueante
  }

  revalidatePath(`/iadmin/consorcios/${managedPropertyId}`, 'layout')
  revalidatePath('/propietario')
  return { paymentId: payment.id as string }
}

export async function rejectPaymentReceipt(
  input: z.input<typeof decisionSchema>,
): Promise<{ ok: true }> {
  const parsed = decisionSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: receipt } = await supabase
    .from('iadmin_payment_receipts')
    .select(
      'id, status, amount, submitted_by_profile_id, liquidation_item_id, iadmin_liquidation_items!inner(id, liquidation_run_id, iadmin_units!inner(code), iadmin_liquidation_runs!inner(id, administration_id, managed_property_id, period_year, period_month))',
    )
    .eq('id', parsed.receiptId)
    .maybeSingle()
  if (!receipt) throw new Error('Comprobante no encontrado')
  if (receipt.status !== 'pending') throw new Error('Este comprobante ya fue procesado')

  const itemRel = Array.isArray(receipt.iadmin_liquidation_items)
    ? receipt.iadmin_liquidation_items[0]
    : receipt.iadmin_liquidation_items
  const runRel = itemRel
    ? Array.isArray(itemRel.iadmin_liquidation_runs)
      ? itemRel.iadmin_liquidation_runs[0]
      : itemRel.iadmin_liquidation_runs
    : null
  const administrationId = runRel?.administration_id as string | undefined
  const managedPropertyId = runRel?.managed_property_id as string | undefined
  if (!administrationId || !managedPropertyId) throw new Error('No se pudo resolver la administración')

  const { profile } = await requireIAdmin({
    capability: 'collections.register',
    administrationId,
  })

  const { error } = await supabase
    .from('iadmin_payment_receipts')
    .update({
      status: 'rejected',
      reviewed_by_profile_id: profile.id,
      reviewed_at: new Date().toISOString(),
      review_notes: parsed.reviewNotes ?? null,
    })
    .eq('id', parsed.receiptId)
  if (error) throw new Error(error.message)

  // Notificar al propietario que reportó el pago.
  try {
    const submitterId = (receipt as any).submitted_by_profile_id as string | null
    const unitCode = (Array.isArray(itemRel?.iadmin_units) ? itemRel?.iadmin_units[0] : (itemRel as any)?.iadmin_units)?.code
    const period = runRel ? `${String(runRel.period_month).padStart(2, '0')}/${runRel.period_year}` : ''
    if (submitterId) {
      await enqueueUserNotification({
        recipientProfileId: submitterId,
        kind: 'payment_receipt_rejected',
        title: 'Tu pago fue rechazado',
        body: `El admin rechazó tu comprobante de la unidad ${unitCode ?? ''}${period ? ` (${period})` : ''}.${parsed.reviewNotes ? ` Motivo: ${parsed.reviewNotes}` : ''}`.trim(),
        link: '/propietario',
        liquidationRunId: runRel?.id as string,
        liquidationItemId: itemRel?.id as string,
        paymentReceiptId: parsed.receiptId,
      })
    }
  } catch {
    // no bloqueante
  }

  revalidatePath(`/iadmin/consorcios/${managedPropertyId}`, 'layout')
  revalidatePath('/propietario')
  return { ok: true }
}

function formatARSCompact(n: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(n)
}

export async function getReceiptSignedUrl(
  receiptId: string,
): Promise<{ url: string | null }> {
  const supabase = await getSupabaseServerClient()
  if (!supabase) return { url: null }

  const { data: receipt } = await supabase
    .from('iadmin_payment_receipts')
    .select(
      'receipt_path, iadmin_liquidation_items!inner(iadmin_liquidation_runs!inner(administration_id))',
    )
    .eq('id', receiptId)
    .maybeSingle()
  if (!receipt?.receipt_path) return { url: null }

  const itemRel = Array.isArray(receipt.iadmin_liquidation_items)
    ? receipt.iadmin_liquidation_items[0]
    : receipt.iadmin_liquidation_items
  const runRel = itemRel
    ? Array.isArray(itemRel.iadmin_liquidation_runs)
      ? itemRel.iadmin_liquidation_runs[0]
      : itemRel.iadmin_liquidation_runs
    : null
  const administrationId = runRel?.administration_id as string | undefined
  if (!administrationId) return { url: null }

  await requireIAdmin({ capability: 'collections.view', administrationId })

  const { data: signed } = await supabase.storage
    .from('iadmin-payment-receipts')
    .createSignedUrl(receipt.receipt_path as string, 60 * 10)
  return { url: signed?.signedUrl ?? null }
}
