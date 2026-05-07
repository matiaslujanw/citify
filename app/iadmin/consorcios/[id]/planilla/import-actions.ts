'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { can, requireIAdmin } from '@/lib/auth'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import type { IAdminExpenseStatus } from '@/lib/types'

// ----------------------------------------------------------------------------
// suggestProviderMatch: buscar proveedor por nombre (fuzzy) antes de imputar
// ----------------------------------------------------------------------------

const matchSchema = z.object({
  administrationId: z.string().uuid(),
  providerName: z.string().trim().min(1).max(120),
})

export type ProviderMatchCandidate = {
  id: string
  name: string
  category: string | null
  isRecurring: boolean
  recurringKind: 'ordinaria' | 'extraordinaria' | null
}

export type ProviderMatchResult = {
  exact: ProviderMatchCandidate | null
  candidates: ProviderMatchCandidate[]
}

/**
 * Busca proveedores por nombre y devuelve:
 * - `exact`: si hay uno cuyo nombre es exacto (case-insensitive, trim)
 * - `candidates`: hasta 5 proveedores que comparten al menos una palabra del nombre
 *
 * Usado por la UI de "Extraer factura" para mostrar el match propuesto
 * antes de confirmar la imputación.
 */
export async function suggestProviderMatch(
  input: z.input<typeof matchSchema>,
): Promise<ProviderMatchResult> {
  const parsed = matchSchema.parse(input)
  await requireIAdmin({
    capability: 'expenses.create',
    administrationId: parsed.administrationId,
  })

  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  const name = parsed.providerName.trim()

  // Exact match (ilike sin wildcards para comparar case-insensitive)
  const { data: exact } = await supabase
    .from('iadmin_providers')
    .select('id, name, category, default_category, is_recurring, recurring_kind')
    .eq('administration_id', parsed.administrationId)
    .ilike('name', name)
    .maybeSingle()

  // Fuzzy: split por palabras + ilike OR
  const tokens = name
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '').trim())
    .filter((t) => t.length >= 3)
  let candidates: ProviderMatchCandidate[] = []
  if (tokens.length > 0) {
    const orExpr = tokens.map((t) => `name.ilike.%${t}%`).join(',')
    const { data: fuzzy } = await supabase
      .from('iadmin_providers')
      .select('id, name, category, default_category, is_recurring, recurring_kind')
      .eq('administration_id', parsed.administrationId)
      .eq('is_active', true)
      .or(orExpr)
      .limit(8)
    candidates = (fuzzy ?? [])
      .filter((p) => !exact || p.id !== exact.id)
      .slice(0, 5)
      .map((p: any) => ({
        id: p.id as string,
        name: p.name as string,
        category: (p.default_category ?? p.category) as string | null,
        isRecurring: Boolean(p.is_recurring),
        recurringKind: (p.recurring_kind as any) ?? null,
      }))
  }

  return {
    exact: exact
      ? {
          id: exact.id as string,
          name: exact.name as string,
          category: ((exact as any).default_category ?? exact.category) as string | null,
          isRecurring: Boolean((exact as any).is_recurring),
          recurringKind: ((exact as any).recurring_kind as any) ?? null,
        }
      : null,
    candidates,
  }
}

// ----------------------------------------------------------------------------
// importExpenseFromExtraction: el botón "Imputar como gasto"
// ----------------------------------------------------------------------------

const importSchema = z.object({
  propertyId: z.string().uuid(),
  // Período al que imputar (si no se pasa, se usa el mes actual)
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  // Proveedor: pasás uno existente (providerId) O nombre para match/crear
  providerId: z.string().uuid().nullable().optional(),
  providerName: z.string().trim().max(120).optional(),
  createProviderIfMissing: z.boolean().optional().default(false),
  // Campos del gasto — el UI los deja editar antes de confirmar
  amount: z.number().positive(),
  description: z.string().trim().max(240).optional(),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expenseKind: z.enum(['ordinaria', 'extraordinaria']).optional().default('ordinaria'),
  category: z.string().trim().max(80).nullable().optional(),
  // Si el user detectó duplicados pero decidió imputar igual, pasamos los ids
  // para registrar el override en el audit log
  ackDuplicateIds: z.array(z.string().uuid()).max(10).optional(),
  // Archivo opcional (si la extracción vino de un PDF / imagen)
  file: z
    .object({
      fileBase64: z.string().min(100),
      fileName: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.number().int().nonnegative().optional(),
      aiSuggestedFields: z.record(z.unknown()).optional(),
      aiConfidence: z.number().min(0).max(100).optional(),
      aiProvider: z.string().optional(),
    })
    .optional(),
})

export type ImportExpenseInput = z.input<typeof importSchema>

export type ImportExpenseResult = {
  expenseId: string
  providerId: string | null
  providerName: string | null
  providerCreated: boolean
  periodId: string
  status: IAdminExpenseStatus
  imputed: boolean
  documentId: string | null
}

export async function importExpenseFromExtraction(
  input: ImportExpenseInput,
): Promise<ImportExpenseResult> {
  const parsed = importSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // 1. Resolver property + administration
  const { data: property } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id')
    .eq('id', parsed.propertyId)
    .maybeSingle()
  if (!property) throw new Error('Consorcio no encontrado')
  const administrationId = property.administration_id as string

  // 2. Capability check
  const { profile, context } = await requireIAdmin({
    capability: 'expenses.create',
    administrationId,
  })

  // 3. Resolver proveedor: providerId directo > match por nombre > crear
  let providerId = parsed.providerId ?? null
  let providerName = ''
  let providerCreated = false

  if (providerId) {
    const { data: existing } = await supabase
      .from('iadmin_providers')
      .select('name')
      .eq('id', providerId)
      .eq('administration_id', administrationId)
      .maybeSingle()
    if (!existing) throw new Error('Proveedor no pertenece a esta administración')
    providerName = existing.name as string
  } else if (parsed.providerName && parsed.providerName.trim().length > 0) {
    const name = parsed.providerName.trim()
    const { data: existing } = await supabase
      .from('iadmin_providers')
      .select('id, name')
      .eq('administration_id', administrationId)
      .ilike('name', name)
      .maybeSingle()

    if (existing) {
      providerId = existing.id as string
      providerName = existing.name as string
    } else if (parsed.createProviderIfMissing) {
      // Chequear capability de providers.manage para crear
      const canManage = can(context, 'providers.manage', { administrationId })
      if (!canManage) {
        throw new Error('No tenés permiso para crear proveedores nuevos')
      }
      const { data: newProvider, error: provError } = await supabase
        .from('iadmin_providers')
        .insert({
          administration_id: administrationId,
          name,
          category: parsed.category ?? null,
          default_category: parsed.category ?? null,
          is_active: true,
        })
        .select('id, name')
        .single()
      if (provError || !newProvider) throw new Error(provError?.message ?? 'Error creando proveedor')
      providerId = newProvider.id as string
      providerName = newProvider.name as string
      providerCreated = true
    } else {
      throw new Error(`Proveedor "${name}" no existe. Confirmá la creación o elegí uno existente.`)
    }
  }

  // 4. Resolver/crear período para (year, month)
  let periodId: string
  {
    const { data: existingPeriod } = await supabase
      .from('iadmin_accounting_periods')
      .select('id, status')
      .eq('managed_property_id', parsed.propertyId)
      .eq('period_year', parsed.year)
      .eq('period_month', parsed.month)
      .maybeSingle()

    if (existingPeriod) {
      if (existingPeriod.status === 'closed') {
        throw new Error(`El período ${parsed.month}/${parsed.year} está cerrado; no se pueden imputar gastos.`)
      }
      periodId = existingPeriod.id as string
    } else {
      const { data: newPeriod, error: periodError } = await supabase
        .from('iadmin_accounting_periods')
        .insert({
          managed_property_id: parsed.propertyId,
          period_year: parsed.year,
          period_month: parsed.month,
          status: 'open',
        })
        .select('id')
        .single()
      if (periodError || !newPeriod) throw new Error(periodError?.message ?? 'Error creando período')
      periodId = newPeriod.id as string
    }
  }

  // 5. Status inicial: imputed si tiene expenses.approve, sino pending_review
  const canApprove = can(context, 'expenses.approve', { administrationId })
  const initialStatus: IAdminExpenseStatus = canApprove ? 'imputed' : 'pending_review'
  const approvedFields = initialStatus === 'imputed'
    ? { approved_by: profile.id, approved_at: new Date().toISOString() }
    : {}

  // 6. Crear el gasto
  const description = parsed.description?.trim()
    || (providerName ? `Factura ${providerName}` : 'Gasto importado')
  const { data: expenseRow, error: insertError } = await supabase
    .from('iadmin_expenses')
    .insert({
      administration_id: administrationId,
      managed_property_id: parsed.propertyId,
      accounting_period_id: periodId,
      provider_id: providerId,
      category: parsed.category ?? null,
      description,
      amount: parsed.amount,
      currency: 'ARS',
      issued_at: parsed.issuedAt ?? null,
      due_at: parsed.dueAt ?? null,
      status: initialStatus,
      expense_kind: parsed.expenseKind ?? 'ordinaria',
      created_by: profile.id,
      ...approvedFields,
    })
    .select('id')
    .single()

  if (insertError || !expenseRow) throw new Error(insertError?.message ?? 'Error creando gasto')
  const expenseId = expenseRow.id as string

  // 7. Subir archivo adjunto + crear document + extraction (mismo patron que createExpense)
  let documentId: string | null = null
  if (parsed.file) {
    try {
      const randomId = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const safeName = parsed.file.fileName
        .normalize('NFKD')
        .replace(/[^\w.\-]+/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120)
      const storagePath = `${administrationId}/${expenseId}/${randomId}-${safeName}`

      const base64 = parsed.file.fileBase64.replace(/^data:[^;]+;base64,/, '')
      const bin = Buffer.from(base64, 'base64')

      const { error: uploadError } = await supabase.storage
        .from('iadmin-expense-documents')
        .upload(storagePath, bin, {
          contentType: parsed.file.mimeType,
          upsert: false,
        })
      if (uploadError) throw new Error(uploadError.message)

      const { data: docRow, error: docError } = await supabase
        .from('iadmin_expense_documents')
        .insert({
          expense_id: expenseId,
          storage_path: storagePath,
          file_name: parsed.file.fileName,
          mime_type: parsed.file.mimeType,
          size_bytes: parsed.file.sizeBytes ?? bin.length,
          uploaded_by: profile.id,
        })
        .select('id')
        .single()

      if (!docError && docRow) {
        documentId = docRow.id as string
        await supabase.from('iadmin_ai_document_extractions').insert({
          document_id: docRow.id,
          status: 'validated',
          provider: parsed.file.aiProvider ?? 'openrouter',
          suggested_fields: parsed.file.aiSuggestedFields ?? {},
          confidence: parsed.file.aiConfidence ?? null,
          validated_by: profile.id,
          validated_at: new Date().toISOString(),
        })
      }
    } catch (docErr) {
      // El gasto ya se creó; loggeamos y seguimos
      await supabase.from('iadmin_audit_logs').insert({
        administration_id: administrationId,
        actor_profile_id: profile.id,
        entity_type: 'iadmin_expenses',
        entity_id: expenseId,
        action: 'expense.doc_upload_failed',
        metadata: { error: docErr instanceof Error ? docErr.message : String(docErr) },
      })
    }
  }

  // 8. Audit log
  await supabase.from('iadmin_audit_logs').insert({
    administration_id: administrationId,
    actor_profile_id: profile.id,
    entity_type: 'iadmin_expenses',
    entity_id: expenseId,
    action: initialStatus === 'imputed' ? 'expense.imported_and_imputed' : 'expense.imported',
    metadata: {
      source: 'mesa-assistant-extraction',
      period: `${parsed.month}/${parsed.year}`,
      providerCreated,
      providerName,
      duplicateOverride: parsed.ackDuplicateIds && parsed.ackDuplicateIds.length > 0
        ? { acknowledgedIds: parsed.ackDuplicateIds }
        : undefined,
    },
  })

  // 9. Revalidar la mesa
  revalidatePath(`/iadmin/consorcios/${parsed.propertyId}`, "layout")

  return {
    expenseId,
    providerId,
    providerName: providerName || null,
    providerCreated,
    periodId,
    status: initialStatus,
    imputed: initialStatus === 'imputed',
    documentId,
  }
}

// ----------------------------------------------------------------------------
// checkExpenseDuplicate: busca si ya hay un gasto similar en el período
// ----------------------------------------------------------------------------

const duplicateSchema = z.object({
  propertyId: z.string().uuid(),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  // Proveedor: uno de los dos
  providerId: z.string().uuid().nullable().optional(),
  providerName: z.string().trim().max(120).optional(),
  amount: z.number().positive().nullable().optional(),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})

export type DuplicateCandidate = {
  id: string
  amount: number
  description: string | null
  issuedAt: string | null
  createdAt: string | null
  createdByName: string | null
  status: IAdminExpenseStatus
  hasDocument: boolean
  // Qué tan probable es que sea el mismo (0-100)
  similarity: number
  reasons: string[] // ej. ['mismo monto', 'misma fecha']
}

export type DuplicateCheckResult = {
  duplicates: DuplicateCandidate[]
  hasExact: boolean // true si existe uno con mismo monto exacto
  hasSameIssuedAt: boolean
}

/**
 * Busca expenses del mismo proveedor en el mismo período (year/month) con
 * monto similar. Útil para advertir al admin antes de re-imputar una factura
 * que ya cargó. No modifica nada. Requiere capability expenses.view.
 */
export async function checkExpenseDuplicate(
  input: z.input<typeof duplicateSchema>,
): Promise<DuplicateCheckResult> {
  const parsed = duplicateSchema.parse(input)
  const supabase = await getSupabaseServerClient()
  if (!supabase) throw new Error('Supabase no configurado')

  // Resolver administration + providerId (si vino por nombre)
  const { data: property } = await supabase
    .from('iadmin_managed_properties')
    .select('id, administration_id')
    .eq('id', parsed.propertyId)
    .maybeSingle()
  if (!property) throw new Error('Consorcio no encontrado')
  const administrationId = property.administration_id as string

  await requireIAdmin({
    capability: 'expenses.view',
    administrationId,
  })

  let providerId = parsed.providerId ?? null
  if (!providerId && parsed.providerName && parsed.providerName.trim().length > 0) {
    const { data: p } = await supabase
      .from('iadmin_providers')
      .select('id')
      .eq('administration_id', administrationId)
      .ilike('name', parsed.providerName.trim())
      .maybeSingle()
    providerId = p?.id ?? null
  }

  // Si no se pudo resolver proveedor, no hay duplicado posible
  if (!providerId) {
    return { duplicates: [], hasExact: false, hasSameIssuedAt: false }
  }

  // Período
  const { data: period } = await supabase
    .from('iadmin_accounting_periods')
    .select('id')
    .eq('managed_property_id', parsed.propertyId)
    .eq('period_year', parsed.year)
    .eq('period_month', parsed.month)
    .maybeSingle()
  if (!period) {
    return { duplicates: [], hasExact: false, hasSameIssuedAt: false }
  }

  // Traer todos los expenses del proveedor en ese período (excluyendo rejected)
  const { data: expenses } = await supabase
    .from('iadmin_expenses')
    .select(`
      id, amount, description, issued_at, status, created_at, created_by,
      iadmin_expense_documents(id)
    `)
    .eq('managed_property_id', parsed.propertyId)
    .eq('provider_id', providerId)
    .eq('accounting_period_id', period.id)
    .neq('status', 'rejected')
    .order('created_at', { ascending: false })

  if (!expenses || expenses.length === 0) {
    return { duplicates: [], hasExact: false, hasSameIssuedAt: false }
  }

  // Resolver nombres de created_by
  const createdByIds = Array.from(
    new Set(expenses.map((e: any) => e.created_by).filter(Boolean) as string[]),
  )
  const profileNameById = new Map<string, string>()
  if (createdByIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', createdByIds)
    for (const p of profiles ?? []) {
      profileNameById.set(p.id, (p as any).full_name || (p as any).email || 'Usuario')
    }
  }

  // Scoring por expense
  const amountRef = parsed.amount ?? null
  const issuedAtRef = parsed.issuedAt ?? null
  let hasExact = false
  let hasSameIssuedAt = false

  const candidates: DuplicateCandidate[] = expenses.map((e: any) => {
    const reasons: string[] = []
    let similarity = 40 // base: mismo proveedor + mismo período
    const amount = Number(e.amount)
    const issuedAt = e.issued_at as string | null

    if (amountRef !== null) {
      const delta = Math.abs(amount - amountRef) / Math.max(amountRef, 1)
      if (delta < 0.005) {
        similarity += 50
        reasons.push('mismo monto')
        hasExact = true
      } else if (delta < 0.02) {
        similarity += 35
        reasons.push(`monto casi idéntico (±${(delta * 100).toFixed(1)}%)`)
      } else if (delta < 0.1) {
        similarity += 10
        reasons.push(`monto similar (±${(delta * 100).toFixed(0)}%)`)
      }
    }

    if (issuedAtRef && issuedAt && issuedAt === issuedAtRef) {
      similarity += 30
      reasons.push('misma fecha de emisión')
      hasSameIssuedAt = true
    }

    const docs = Array.isArray(e.iadmin_expense_documents) ? e.iadmin_expense_documents : []

    return {
      id: e.id as string,
      amount,
      description: (e.description as string) ?? null,
      issuedAt,
      createdAt: (e.created_at as string) ?? null,
      createdByName: e.created_by ? (profileNameById.get(e.created_by) ?? null) : null,
      status: e.status as IAdminExpenseStatus,
      hasDocument: docs.length > 0,
      similarity: Math.min(100, similarity),
      reasons,
    }
  })

  // Filtrar: sólo devolvemos los que son realmente sospechosos (similarity >= 50)
  const duplicates = candidates
    .filter((c) => c.similarity >= 50)
    .sort((a, b) => b.similarity - a.similarity)

  return {
    duplicates,
    hasExact,
    hasSameIssuedAt,
  }
}

