'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { findMembership, requireIAdmin } from '@/lib/auth'
import { canTransition } from '@/lib/iadmin/expense-status'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import type { IAdminCapability, IAdminExpenseStatus } from '@/lib/types'

const createExpenseSchema = z.object({
  administrationId: z.string().uuid(),
  managedPropertyId: z.string().uuid(),
  accountingPeriodId: z.string().uuid().nullable().optional(),
  // Proveedor: podes pasar uno existente (providerId) o uno a crear (providerName)
  providerId: z.string().uuid().nullable().optional(),
  providerName: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().min(1).max(240),
  amount: z.number().nonnegative(),
  currency: z.string().trim().min(1).max(8).default('ARS'),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expenseKind: z.enum(['ordinaria', 'extraordinaria']).optional().default('ordinaria'),
  // Default: true. Si el user tiene expenses.approve, el gasto se crea imputado al
  // periodo abierto. Sino, queda en pending_review.
  autoImpute: z.boolean().optional().default(true),
  // Documento adjunto: si se subio un archivo con IA y el usuario lo confirmo,
  // lo pasamos aca para asociarlo al gasto junto con la extraccion ya validada.
  // El server sube el archivo al bucket y crea doc + extraction en una transaccion.
  draftDocument: z.object({
    fileBase64: z.string().min(100),
    fileName: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().optional(),
    aiSuggestedFields: z.record(z.unknown()).optional(),
    aiConfidence: z.number().min(0).max(100).optional(),
    aiProvider: z.string().optional(),
  }).optional(),
})

export type CreateExpenseInput = z.input<typeof createExpenseSchema>

export async function createExpense(input: CreateExpenseInput) {
  const parsed = createExpenseSchema.parse(input)
  const { profile, context } = await requireIAdmin({
    capability: 'expenses.create',
    administrationId: parsed.administrationId,
  })

  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // Verificamos que la property pertenece a la administracion
  const { data: propertyRow } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id')
    .eq('id', parsed.managedPropertyId)
    .maybeSingle()

  if (!propertyRow || propertyRow.administration_id !== parsed.administrationId) {
    throw new Error('Consorcio fuera de la administracion')
  }

  // --- Proveedor inline: si viene providerName y no providerId, creamos ---
  let providerId = parsed.providerId ?? null
  if (!providerId && parsed.providerName && parsed.providerName.trim().length > 0) {
    // Existe ya con ese nombre?
    const { data: existing } = await supabase
      .from('iadmin_providers')
      .select('id')
      .eq('administration_id', parsed.administrationId)
      .ilike('name', parsed.providerName.trim())
      .maybeSingle()

    if (existing) {
      providerId = existing.id as string
    } else {
      const { data: newProvider, error: provError } = await supabase
        .from('iadmin_providers')
        .insert({
          administration_id: parsed.administrationId,
          name: parsed.providerName.trim(),
          category: parsed.category ?? null,
          default_category: parsed.category ?? null,
          is_active: true,
        })
        .select('id')
        .single()
      if (provError) throw new Error(provError.message)
      providerId = newProvider.id as string
    }
  } else if (providerId && parsed.category) {
    // Proveedor existente: memorizamos su default_category si no tiene una
    await supabase
      .from('iadmin_providers')
      .update({ default_category: parsed.category })
      .eq('id', providerId)
      .is('default_category', null)
  }

  // --- Periodo contable: si no vino, buscamos el abierto del mes; si no existe, lo creamos ---
  let accountingPeriodId = parsed.accountingPeriodId ?? null
  if (!accountingPeriodId) {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1

    const { data: existingPeriod } = await supabase
      .from('iadmin_accounting_periods')
      .select('id, status')
      .eq('managed_property_id', parsed.managedPropertyId)
      .eq('period_year', year)
      .eq('period_month', month)
      .maybeSingle()

    if (existingPeriod) {
      accountingPeriodId = existingPeriod.id as string
    } else {
      const { data: newPeriod, error: periodError } = await supabase
        .from('iadmin_accounting_periods')
        .insert({
          managed_property_id: parsed.managedPropertyId,
          period_year: year,
          period_month: month,
          status: 'open',
        })
        .select('id')
        .single()
      if (periodError) throw new Error(periodError.message)
      accountingPeriodId = newPeriod.id as string
    }
  }

  // --- Status inicial: si el user puede aprobar y pidio auto-imputar, directo a imputed ---
  const canApprove = context.isSuperAdmin || (context.memberships
    .find((m) => m.administration.id === parsed.administrationId)
    ?.capabilities.includes('expenses.approve') ?? false)
  const initialStatus: IAdminExpenseStatus = parsed.autoImpute && canApprove ? 'imputed' : 'pending_review'
  const approvedFields = initialStatus === 'imputed'
    ? { approved_by: profile.id, approved_at: new Date().toISOString() }
    : {}

  const { data, error } = await supabase
    .from('iadmin_expenses')
    .insert({
      administration_id: parsed.administrationId,
      managed_property_id: parsed.managedPropertyId,
      accounting_period_id: accountingPeriodId,
      provider_id: providerId,
      category: parsed.category ?? null,
      description: parsed.description,
      amount: parsed.amount,
      currency: parsed.currency,
      issued_at: parsed.issuedAt ?? null,
      due_at: parsed.dueAt ?? null,
      status: initialStatus,
      expense_kind: parsed.expenseKind ?? 'ordinaria',
      created_by: profile.id,
      ...approvedFields,
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(error.message)
  }

  // Si vino documento draft, subimos el archivo al bucket, creamos el registro
  // y guardamos la extraccion IA como VALIDADA (el admin la verifico visualmente
  // al cargar el form con los sugeridos).
  if (parsed.draftDocument) {
    try {
      const randomId = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const safeName = parsed.draftDocument.fileName
        .normalize('NFKD')
        .replace(/[^\w.\-]+/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120)
      const storagePath = `${parsed.administrationId}/${data.id}/${randomId}-${safeName}`

      // decodificar base64 a Uint8Array
      const base64 = parsed.draftDocument.fileBase64.replace(/^data:[^;]+;base64,/, '')
      const bin = Buffer.from(base64, 'base64')

      const { error: uploadError } = await supabase.storage
        .from('iadmin-expense-documents')
        .upload(storagePath, bin, {
          contentType: parsed.draftDocument.mimeType,
          upsert: false,
        })

      if (uploadError) throw new Error(uploadError.message)

      const { data: docRow, error: docError } = await supabase
        .from('iadmin_expense_documents')
        .insert({
          expense_id: data.id,
          storage_path: storagePath,
          file_name: parsed.draftDocument.fileName,
          mime_type: parsed.draftDocument.mimeType,
          size_bytes: parsed.draftDocument.sizeBytes ?? bin.length,
          uploaded_by: profile.id,
        })
        .select('id')
        .single()

      if (!docError && docRow) {
        await supabase.from('iadmin_ai_document_extractions').insert({
          document_id: docRow.id,
          status: 'validated',
          provider: parsed.draftDocument.aiProvider ?? 'openrouter',
          suggested_fields: parsed.draftDocument.aiSuggestedFields ?? {},
          confidence: parsed.draftDocument.aiConfidence ?? null,
          validated_by: profile.id,
          validated_at: new Date().toISOString(),
        })
      }
    } catch (docErr) {
      // El gasto ya se creó; dejamos un audit y seguimos. El admin puede resubir
      // el documento manualmente desde el detalle.
      await supabase.from('iadmin_audit_logs').insert({
        administration_id: parsed.administrationId,
        actor_profile_id: profile.id,
        entity_type: 'iadmin_expenses',
        entity_id: data.id,
        action: 'expense.doc_upload_failed',
        metadata: { error: docErr instanceof Error ? docErr.message : String(docErr) },
      })
    }
  }

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: parsed.administrationId,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_expenses',
    entity_id: data.id,
    action: initialStatus === 'imputed' ? 'expense.created_and_imputed' : 'expense.created',
    metadata: {
      amount: parsed.amount,
      currency: parsed.currency,
      status: initialStatus,
      has_ai_doc: Boolean(parsed.draftDocument),
    },
  })

  revalidatePath('/iadmin/gastos')
  revalidatePath('/iadmin/cartera')
  revalidatePath(`/iadmin/consorcios/${parsed.managedPropertyId}`, "layout")
  return { id: data.id as string, status: initialStatus }
}

const changeStatusSchema = z.object({
  expenseId: z.string().uuid(),
  nextStatus: z.enum(['draft', 'pending_review', 'needs_doc', 'approved', 'rejected', 'imputed']),
  note: z.string().trim().max(500).optional(),
})

export async function changeExpenseStatus(input: z.input<typeof changeStatusSchema>) {
  const parsed = changeStatusSchema.parse(input)
  const { profile, context } = await requireIAdmin({ capability: 'expenses.view' })

  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: expense } = await supabase
    .from('iadmin_expenses')
    .select('id, status, administration_id')
    .eq('id', parsed.expenseId)
    .maybeSingle()

  if (!expense) throw new Error('Gasto no encontrado')

  if (!context.isSuperAdmin) {
    const membership = findMembership(context, expense.administration_id)
    const capabilities: ReadonlySet<IAdminCapability> = new Set(membership?.capabilities ?? [])
    if (!canTransition(expense.status, parsed.nextStatus, capabilities)) {
      throw new Error('Transicion no permitida para tu rol')
    }
  }

  const patch: Record<string, unknown> = { status: parsed.nextStatus }
  if (parsed.nextStatus === 'approved') {
    patch.approved_by = profile.id
    patch.approved_at = new Date().toISOString()
  }
  if (parsed.nextStatus === 'rejected' && parsed.note) {
    patch.rejected_reason = parsed.note
  }

  const { error } = await supabase.from('iadmin_expenses').update(patch).eq('id', parsed.expenseId)
  if (error) throw new Error(error.message)

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: expense.administration_id,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_expenses',
    entity_id: parsed.expenseId,
    action: `expense.${parsed.nextStatus}`,
    metadata: parsed.note ? { note: parsed.note } : null,
  })

  revalidatePath('/iadmin/gastos')
  revalidatePath(`/iadmin/gastos/${parsed.expenseId}`)
}

const attachDocumentSchema = z.object({
  expenseId: z.string().uuid(),
  storagePath: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
})

// Registra el documento ya subido al bucket y crea la fila vacia de extraccion
// (status=pending). Aqui no llamamos a un proveedor de IA: dejamos el hook listo
// para que la fase 2 lo reemplace por una integracion real.
export async function attachExpenseDocument(input: z.input<typeof attachDocumentSchema>) {
  const parsed = attachDocumentSchema.parse(input)
  const { profile } = await requireIAdmin({ capability: 'documents.upload' })

  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: expense } = await supabase
    .from('iadmin_expenses')
    .select('id, administration_id, status')
    .eq('id', parsed.expenseId)
    .maybeSingle()

  if (!expense) throw new Error('Gasto no encontrado')

  const { data: doc, error } = await supabase
    .from('iadmin_expense_documents')
    .insert({
      expense_id: parsed.expenseId,
      storage_path: parsed.storagePath,
      file_name: parsed.fileName,
      mime_type: parsed.mimeType ?? null,
      size_bytes: parsed.sizeBytes ?? null,
      uploaded_by: profile.id,
    })
    .select('id')
    .single()

  if (error) throw new Error(error.message)

  await supabase.from('iadmin_ai_document_extractions').insert({
    document_id: doc.id,
    status: 'pending',
    provider: 'manual',
    suggested_fields: {},
  })

  // si estaba needs_doc, vuelve a pending_review
  if (expense.status === 'needs_doc') {
    await supabase.from('iadmin_expenses').update({ status: 'pending_review' }).eq('id', parsed.expenseId)
  }

  await supabase.from('iadmin_audit_logs').insert({
    administration_id: expense.administration_id,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_expense_documents',
    entity_id: doc.id,
    action: 'document.attached',
    metadata: { file_name: parsed.fileName },
  })

  revalidatePath(`/iadmin/gastos/${parsed.expenseId}`)
  return { id: doc.id as string }
}

const validateExtractionSchema = z.object({
  extractionId: z.string().uuid(),
  decision: z.enum(['validated', 'rejected']),
  notes: z.string().trim().max(500).optional(),
})

export async function validateAIExtraction(input: z.input<typeof validateExtractionSchema>) {
  const parsed = validateExtractionSchema.parse(input)
  const { profile } = await requireIAdmin({ capability: 'documents.validate' })

  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const { data: extraction } = await supabase
    .from('iadmin_ai_document_extractions')
    .select('id, document_id, iadmin_expense_documents ( expense_id, iadmin_expenses ( administration_id ) )')
    .eq('id', parsed.extractionId)
    .maybeSingle()

  if (!extraction) throw new Error('Extraccion no encontrada')

  const { error } = await supabase
    .from('iadmin_ai_document_extractions')
    .update({
      status: parsed.decision,
      validated_by: profile.id,
      validated_at: new Date().toISOString(),
      validation_notes: parsed.notes ?? null,
    })
    .eq('id', parsed.extractionId)

  if (error) throw new Error(error.message)

  const docRow = Array.isArray(extraction.iadmin_expense_documents)
    ? extraction.iadmin_expense_documents[0]
    : extraction.iadmin_expense_documents
  const expenseRow = docRow?.iadmin_expenses
    ? Array.isArray(docRow.iadmin_expenses)
      ? docRow.iadmin_expenses[0]
      : docRow.iadmin_expenses
    : null

  if (expenseRow?.administration_id) {
    await supabase.from('iadmin_audit_logs').insert({
      administration_id: expenseRow.administration_id,
      actor_profile_id: profile.id,
      entity_type: 'iadmin_ai_document_extractions',
      entity_id: parsed.extractionId,
      action: `extraction.${parsed.decision}`,
      metadata: parsed.notes ? { notes: parsed.notes } : null,
    })
  }

  if (docRow?.expense_id) {
    revalidatePath(`/iadmin/gastos/${docRow.expense_id}`)
  }
}
