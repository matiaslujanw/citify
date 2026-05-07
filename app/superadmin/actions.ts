'use server'

import { revalidatePath } from 'next/cache'
import * as XLSX from 'xlsx'
import { z } from 'zod'
import { requireProfile } from '@/lib/auth'
import type {
  IAdminUnitKind,
  InitialOccupancyImportConfirmResult,
  InitialOccupancyImportPreview,
  InitialOccupancyImportRowDraft,
  InitialOccupancyImportRowStatus,
  InitialOccupancyUnitDecision,
  SuperAdminCreateManagedPropertyInput,
  SuperAdminCreateManagedPropertyResult,
  UnitProfileRelationship,
  UserRole,
} from '@/lib/types'
import { inferInitialOccupancyMapping } from '@/lib/superadmin/initial-occupancy-ai'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

function avatarFromName(fullName: string) {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'U'
}

const createPlatformUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(160),
  phone: z.string().trim().max(40).nullable().optional(),
  password: z.string().min(8).max(72),
  role: z.enum(['super_admin', 'negocio_admin', 'consorcio_admin', 'propietario', 'vecino']),
  buildingId: z.string().uuid().nullable().optional(),
  businessId: z.string().uuid().nullable().optional(),
})

type ImportRelationship = 'propietario' | 'vecino_principal' | 'vecino_adicional'

function relationshipRole(relationship: ImportRelationship): UserRole {
  return relationship === 'propietario' ? 'propietario' : 'vecino'
}

function parseBoolean(value: string | undefined) {
  return ['1', 'true', 'si', 'yes', 'x'].includes((value ?? '').trim().toLowerCase())
}

function parseImportCsv(raw: string) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length < 2) {
    throw new Error('La importacion necesita encabezado y al menos una fila.')
  }

  const delimiter = lines[0].includes(';') ? ';' : ','
  const headers = lines[0].split(delimiter).map((header) => header.trim())

  return lines.slice(1).map((line, index) => {
    const values = line.split(delimiter).map((value) => value.trim())
    const row = Object.fromEntries(headers.map((header, columnIndex) => [header, values[columnIndex] ?? '']))
    return { row, line: index + 2 }
  })
}

type SpreadsheetRow = {
  sheetName: string
  sourceRowNumber: number
  values: Record<string, string>
}

type SpreadsheetSheet = {
  name: string
  headers: string[]
  rows: SpreadsheetRow[]
}

type ImportColumnMapping = {
  unitCode: string | null
  floor: string | null
  fullName: string | null
  email: string | null
  phone: string | null
  relationship: string | null
  primary: string | null
  unitKind: string | null
}

type ImportAnalysisContext = {
  ownerKeywords: string[]
  primaryKeywords: string[]
  additionalKeywords: string[]
}

type ConfirmableImportRow = Pick<
  InitialOccupancyImportRowDraft,
  | 'id'
  | 'status'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'unitCode'
  | 'floor'
  | 'relationshipType'
  | 'isPrimary'
  | 'unitKind'
  | 'existingUnitId'
  | 'unitDecision'
  | 'sourceRowNumber'
  | 'sourceSheet'
>

const importColumnAliases: Record<keyof ImportColumnMapping, string[]> = {
  unitCode: ['unit_code', 'unitcode', 'unidad', 'depto', 'dpto', 'apto', 'apartamento', 'departamento', 'unidad_funcional', 'uf', 'lote'],
  floor: ['floor', 'piso', 'nivel', 'planta'],
  fullName: ['full_name', 'fullname', 'nombre', 'nombre_completo', 'nombre_y_apellido', 'titular', 'residente'],
  email: ['email', 'mail', 'correo', 'correo_electronico', 'e_mail'],
  phone: ['phone', 'telefono', 'teléfono', 'celular', 'movil', 'móvil', 'whatsapp'],
  relationship: ['relationship', 'relationship_type', 'relacion', 'vinculo', 'rol', 'tipo', 'condicion', 'condición', 'parentesco'],
  primary: ['is_primary', 'principal', 'titular_principal', 'es_principal'],
  unitKind: ['unit_kind', 'tipo_unidad', 'tipo', 'clase_unidad'],
}

const defaultOwnerKeywords = ['propietario', 'titular', 'dueño', 'dueno', 'owner']
const defaultPrimaryKeywords = ['vecino_principal', 'principal', 'residente', 'habitante', 'inquilino']
const defaultAdditionalKeywords = ['vecino_adicional', 'adicional', 'conviviente', 'familiar', 'grupo familiar']
const validRelationships = ['propietario', 'vecino_principal', 'vecino_adicional'] as const

function normalizeText(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function readSpreadsheetFile(fileBase64: string, fileName: string): SpreadsheetSheet[] {
  const workbook = XLSX.read(fileBase64, { type: 'base64' })
  const sheets: SpreadsheetSheet[] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const matrix = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    })

    const rows = matrix
      .map((row) => row.map((cell) => String(cell ?? '').trim()))
      .filter((row) => row.some((cell) => cell.length > 0))

    if (rows.length < 2) {
      continue
    }

    const headerRowIndex = rows.findIndex((row) => row.filter(Boolean).length >= 2)
    if (headerRowIndex === -1) {
      continue
    }

    const headers = rows[headerRowIndex].map((header, index) => header || `columna_${index + 1}`)
    const dataRows = rows.slice(headerRowIndex + 1)
    const parsedRows = dataRows
      .map((row, index) => ({
        sheetName,
        sourceRowNumber: headerRowIndex + index + 2,
        values: Object.fromEntries(headers.map((header, columnIndex) => [header, String(row[columnIndex] ?? '').trim()])),
      }))
      .filter((row) => Object.values(row.values).some(Boolean))

    if (parsedRows.length > 0) {
      sheets.push({ name: sheetName, headers, rows: parsedRows })
    }
  }

  if (sheets.length === 0) {
    throw new Error(`No se encontraron filas utiles en ${fileName}.`)
  }

  return sheets
}

function detectColumns(headers: string[]): ImportColumnMapping {
  const normalized = headers.map((header) => ({ original: header, normalized: normalizeText(header) }))
  const mapping: ImportColumnMapping = {
    unitCode: null,
    floor: null,
    fullName: null,
    email: null,
    phone: null,
    relationship: null,
    primary: null,
    unitKind: null,
  }

  for (const [key, aliases] of Object.entries(importColumnAliases) as Array<[keyof ImportColumnMapping, string[]]>) {
    const match = normalized.find((header) => aliases.includes(header.normalized))
    if (match) {
      mapping[key] = match.original
    }
  }

  return mapping
}

function mergeColumnMappings(base: ImportColumnMapping, aiMapping: Partial<ImportColumnMapping>): ImportColumnMapping {
  return {
    unitCode: base.unitCode ?? aiMapping.unitCode ?? null,
    floor: base.floor ?? aiMapping.floor ?? null,
    fullName: base.fullName ?? aiMapping.fullName ?? null,
    email: base.email ?? aiMapping.email ?? null,
    phone: base.phone ?? aiMapping.phone ?? null,
    relationship: base.relationship ?? aiMapping.relationship ?? null,
    primary: base.primary ?? aiMapping.primary ?? null,
    unitKind: base.unitKind ?? aiMapping.unitKind ?? null,
  }
}

function getMappedValue(row: Record<string, string>, key: string | null) {
  return key ? String(row[key] ?? '').trim() : ''
}

function parseRelationshipFromValue(value: string, context: ImportAnalysisContext): UnitProfileRelationship | null {
  const normalized = normalizeText(value).replace(/_/g, ' ')
  if (!normalized) return null

  if (context.ownerKeywords.some((keyword) => normalized.includes(normalizeText(keyword).replace(/_/g, ' ')))) {
    return 'propietario'
  }
  if (context.primaryKeywords.some((keyword) => normalized.includes(normalizeText(keyword).replace(/_/g, ' ')))) {
    return 'vecino_principal'
  }
  if (context.additionalKeywords.some((keyword) => normalized.includes(normalizeText(keyword).replace(/_/g, ' ')))) {
    return 'vecino_adicional'
  }

  if (validRelationships.includes(normalized.replace(/ /g, '_') as UnitProfileRelationship)) {
    return normalized.replace(/ /g, '_') as UnitProfileRelationship
  }

  return null
}

function parseUnitKind(value: string): IAdminUnitKind {
  const normalized = normalizeText(value)
  if (['departamento', 'depto', 'dpto', 'apto'].includes(normalized)) return 'departamento'
  if (['casa'].includes(normalized)) return 'casa'
  if (['local'].includes(normalized)) return 'local'
  if (['cochera', 'garage'].includes(normalized)) return 'cochera'
  if (['baulera'].includes(normalized)) return 'baulera'
  return 'departamento'
}

function buildRawPreview(values: Record<string, string>) {
  return Object.entries(values)
    .filter(([, value]) => value)
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ')
}

function summarizeImportRows(rows: InitialOccupancyImportRowDraft[]): InitialOccupancyImportPreview['summary'] {
  return {
    totalRows: rows.length,
    readyRows: rows.filter((row) => row.status === 'ready').length,
    pendingRows: rows.filter((row) => row.status === 'pending').length,
    errorRows: rows.filter((row) => row.status === 'error').length,
    unitsToCreate: rows.filter((row) => row.unitDecision === 'create').length,
    unitsToReuse: rows.filter((row) => row.unitDecision === 'reuse').length,
    usersToCreateEstimate: rows.filter((row) => row.status === 'ready').length,
    membershipsToUpsert: rows.filter((row) => row.status === 'ready').length,
  }
}

function finalizeImportRows(rows: InitialOccupancyImportRowDraft[]) {
  const groupedByUnit = new Map<string, InitialOccupancyImportRowDraft[]>()

  for (const row of rows) {
    const key = normalizeText(row.unitCode)
    if (!key) continue
    const group = groupedByUnit.get(key) ?? []
    group.push(row)
    groupedByUnit.set(key, group)
  }

  return rows.map((row) => {
    const reasons: string[] = []
    const normalizedUnit = normalizeText(row.unitCode)
    const sameUnitRows = normalizedUnit ? groupedByUnit.get(normalizedUnit) ?? [] : []
    const principalCount = sameUnitRows.filter((item) => item.relationshipType === 'vecino_principal').length

    if (!row.unitCode.trim()) reasons.push('No pudimos detectar la unidad.')
    if (!row.fullName.trim()) reasons.push('Falta nombre completo.')
    if (!row.email.trim()) reasons.push('Falta email.')
    if (!row.relationshipType) reasons.push('No pudimos inferir la relación con la unidad.')
    if (row.relationshipType === 'vecino_principal' && principalCount > 1) {
      reasons.push('Hay más de un vecino principal propuesto para la misma unidad.')
    }

    const status: InitialOccupancyImportRowStatus = reasons.length === 0 ? 'ready' : 'pending'
    const unitDecision: InitialOccupancyUnitDecision = row.unitCode.trim()
      ? row.existingUnitId
        ? 'reuse'
        : row.unitDecision === 'reuse'
          ? 'reuse'
          : 'create'
      : 'unresolved'

    return {
      ...row,
      status,
      statusReason: reasons[0] ?? null,
      unitDecision,
    }
  })
}

async function findOrCreatePlatformProfile(input: {
  fullName: string
  email: string
  phone: string | null
  password: string
  role: UserRole
  buildingId: string | null
  businessId?: string | null
}) {
  const admin = getSupabaseAdminClient()
  if (!admin) {
    throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para crear usuarios desde superadmin.')
  }

  const normalizedEmail = input.email.toLowerCase()
  const { data: existingProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle()

  let profileId = existingProfile?.id as string | undefined
  if (!profileId) {
    const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
      email: normalizedEmail,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName },
    })
    if (createError || !createdUser.user) {
      throw new Error(createError?.message ?? 'No se pudo crear el usuario.')
    }
    profileId = createdUser.user.id
  }

  const { error } = await admin.from('profiles').upsert({
    id: profileId,
    email: normalizedEmail,
    full_name: input.fullName,
    avatar_text: avatarFromName(input.fullName),
    role: input.role,
    phone: input.phone,
    building_id: input.buildingId,
    business_id: input.businessId ?? null,
  })
  if (error) throw new Error(error.message)

  return profileId
}

export async function createPlatformUser(input: z.input<typeof createPlatformUserSchema>) {
  const parsed = createPlatformUserSchema.parse(input)
  await requireProfile(['super_admin'])

  const admin = getSupabaseAdminClient()
  if (!admin) {
    throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para crear usuarios desde superadmin.')
  }

  const role = parsed.role as UserRole
  const profileId = await findOrCreatePlatformProfile({
    fullName: parsed.fullName,
    email: parsed.email,
    phone: parsed.phone ?? null,
    password: parsed.password,
    role,
    buildingId: role === 'consorcio_admin' ? null : parsed.buildingId ?? null,
    businessId: parsed.businessId ?? null,
  })

  if (role === 'negocio_admin' && parsed.businessId) {
    await admin.from('businesses').update({ owner_profile_id: profileId }).eq('id', parsed.businessId)
  }

  if (role === 'consorcio_admin' && parsed.buildingId) {
    const { count: assignmentsCount } = await admin
      .from('building_admin_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', profileId)

    const isPrimaryAssignment = (assignmentsCount ?? 0) === 0

    await admin.from('building_admin_assignments').upsert(
      {
        profile_id: profileId,
        building_id: parsed.buildingId,
        is_primary: isPrimaryAssignment,
      },
      { onConflict: 'profile_id,building_id' },
    )

    if (isPrimaryAssignment) {
      await admin.from('profiles').update({ building_id: parsed.buildingId }).eq('id', profileId)
    }

    const { data: property } = await admin
      .from('iadmin_managed_properties')
      .select('administration_id')
      .eq('building_id', parsed.buildingId)
      .limit(1)
      .maybeSingle()

    if (property?.administration_id) {
      const { count: grantsCount } = await admin
        .from('iadmin_role_grants')
        .select('id', { count: 'exact', head: true })
        .eq('profile_id', profileId)

      await admin.from('iadmin_role_grants').upsert(
        {
          administration_id: property.administration_id,
          profile_id: profileId,
          operational_role: 'titular',
          is_primary: (grantsCount ?? 0) === 0,
        },
        { onConflict: 'administration_id,profile_id' },
      )
    }
  }

  revalidatePath('/superadmin')
  return { profileId }
}

const propertyKindValues = ['consorcio', 'barrio_privado', 'edificio', 'mixto'] as const

const createManagedPropertySchema = z.object({
  building: z.object({
    name: z.string().trim().min(2).max(120),
    address: z.string().trim().min(5).max(200),
    totalUnits: z.number().int().min(0).max(100000),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
  }),
  administration: z.object({
    name: z.string().trim().min(2).max(120),
    legalName: z.string().trim().max(160).nullable().optional(),
    taxId: z.string().trim().max(32).nullable().optional(),
    contactEmail: z.string().trim().email().max(160).nullable().optional(),
    contactPhone: z.string().trim().max(40).nullable().optional(),
  }),
  managedProperty: z.object({
    displayName: z.string().trim().max(120).nullable().optional(),
    propertyKind: z.enum(propertyKindValues),
    taxId: z.string().trim().max(32).nullable().optional(),
    managedSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    managementFeePct: z.number().min(0).max(100).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  }),
  adminProfileId: z.string().uuid(),
})

const createManagedPropertyResultSchema = z.object({
  building_id: z.string().uuid(),
  administration_id: z.string().uuid(),
  managed_property_id: z.string().uuid(),
})

export async function createManagedProperty(
  input: SuperAdminCreateManagedPropertyInput,
): Promise<SuperAdminCreateManagedPropertyResult> {
  const parsed = createManagedPropertySchema.parse(input)
  const { profile } = await requireProfile(['super_admin'])

  const admin = getSupabaseAdminClient()
  if (!admin) {
    throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para crear consorcios desde superadmin.')
  }

  const { data, error } = await admin.rpc('superadmin_create_consorcio', {
    building_name: parsed.building.name,
    building_address: parsed.building.address,
    building_total_units: parsed.building.totalUnits,
    building_latitude: parsed.building.latitude ?? null,
    building_longitude: parsed.building.longitude ?? null,
    administration_name: parsed.administration.name,
    administration_legal_name: parsed.administration.legalName ?? null,
    administration_tax_id: parsed.administration.taxId ?? null,
    administration_contact_email: parsed.administration.contactEmail ?? null,
    administration_contact_phone: parsed.administration.contactPhone ?? null,
    property_display_name: parsed.managedProperty.displayName ?? null,
    property_kind: parsed.managedProperty.propertyKind,
    property_tax_id: parsed.managedProperty.taxId ?? null,
    property_managed_since: parsed.managedProperty.managedSince ?? null,
    property_management_fee_pct: parsed.managedProperty.managementFeePct ?? null,
    property_notes: parsed.managedProperty.notes ?? null,
    admin_profile_id: parsed.adminProfileId,
    creator_profile_id: profile.id,
  })

  if (error) {
    throw new Error(error.message)
  }

  const result = createManagedPropertyResultSchema.parse(data)

  revalidatePath('/superadmin')
  revalidatePath('/iadmin')
  revalidatePath('/iadmin/cartera')
  revalidatePath(`/iadmin/consorcios/${result.managed_property_id}`, "layout")

  return {
    buildingId: result.building_id,
    administrationId: result.administration_id,
    managedPropertyId: result.managed_property_id,
  }
}

const analyzeInitialOccupancyFileSchema = z.object({
  buildingId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(120),
  fileBase64: z.string().trim().min(10),
})

const confirmImportRowSchema = z.object({
  id: z.string(),
  status: z.enum(['ready', 'pending', 'error']),
  fullName: z.string().trim(),
  email: z.string().trim(),
  phone: z.string().trim(),
  unitCode: z.string().trim(),
  floor: z.string().trim().nullable(),
  relationshipType: z.enum(validRelationships),
  isPrimary: z.boolean(),
  unitKind: z.enum(['departamento', 'casa', 'local', 'cochera', 'baulera', 'otro']),
  existingUnitId: z.string().uuid().nullable(),
  unitDecision: z.enum(['reuse', 'create', 'unresolved']),
  sourceRowNumber: z.number().int().min(1),
  sourceSheet: z.string().trim().min(1),
})

const confirmInitialOccupancyImportSchema = z.object({
  buildingId: z.string().uuid(),
  rows: z.array(confirmImportRowSchema),
})

export async function analyzeInitialOccupancyFile(
  input: z.input<typeof analyzeInitialOccupancyFileSchema>,
): Promise<InitialOccupancyImportPreview> {
  const parsed = analyzeInitialOccupancyFileSchema.parse(input)
  await requireProfile(['super_admin'])

  const admin = getSupabaseAdminClient()
  if (!admin) {
    throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para analizar importaciones desde superadmin.')
  }

  const { data: building } = await admin
    .from('buildings')
    .select('id, name')
    .eq('id', parsed.buildingId)
    .maybeSingle()

  if (!building) {
    throw new Error('No encontramos el edificio seleccionado.')
  }

  const { data: property } = await admin
    .from('iadmin_managed_properties')
    .select('id')
    .eq('building_id', parsed.buildingId)
    .limit(1)
    .maybeSingle()

  if (!property?.id) {
    throw new Error('El edificio seleccionado todavía no tiene una propiedad IAdmin asociada.')
  }

  const { data: units } = await admin
    .from('iadmin_units')
    .select('id, code, floor, kind')
    .eq('managed_property_id', property.id)

  const existingUnits = new Map(
    (units ?? []).map((unit) => [normalizeText(String(unit.code ?? '')), { id: String(unit.id), code: String(unit.code ?? '') }]),
  )

  const sheets = readSpreadsheetFile(parsed.fileBase64, parsed.fileName)
  const warnings: string[] = []
  const rows: InitialOccupancyImportRowDraft[] = []
  const detectedColumns: Record<string, string | null> = {}

  for (const sheet of sheets) {
    const directMapping = detectColumns(sheet.headers)
    let aiMapping: Partial<ImportColumnMapping> = {}
    let context: ImportAnalysisContext = {
      ownerKeywords: defaultOwnerKeywords,
      primaryKeywords: defaultPrimaryKeywords,
      additionalKeywords: defaultAdditionalKeywords,
    }

    try {
      const aiResult = await inferInitialOccupancyMapping({
        buildingName: String(building.name),
        sheetName: sheet.name,
        headers: sheet.headers,
        sampleRows: sheet.rows.slice(0, 15).map((row) => row.values),
      })

      aiMapping = aiResult.mapping
      context = {
        ownerKeywords: [...defaultOwnerKeywords, ...(aiResult.ownerKeywords ?? [])],
        primaryKeywords: [...defaultPrimaryKeywords, ...(aiResult.primaryKeywords ?? [])],
        additionalKeywords: [...defaultAdditionalKeywords, ...(aiResult.additionalKeywords ?? [])],
      }
      warnings.push(...(aiResult.notes ?? []))
    } catch (error) {
      warnings.push(
        `La IA no pudo interpretar completamente la hoja ${sheet.name}. Se usaron heuristicas locales. ${
          error instanceof Error ? error.message : ''
        }`.trim(),
      )
    }

    const mapping = mergeColumnMappings(directMapping, aiMapping)
    for (const [key, value] of Object.entries(mapping)) {
      if (!(key in detectedColumns) || detectedColumns[key] === null) {
        detectedColumns[key] = value
      }
    }

    const groupedCandidates = new Map<string, number>()
    for (const row of sheet.rows) {
      const rawUnitCode = getMappedValue(row.values, mapping.unitCode)
      const unitKey = normalizeText(rawUnitCode)
      if (unitKey) {
        groupedCandidates.set(unitKey, (groupedCandidates.get(unitKey) ?? 0) + 1)
      }
    }

    let rowIndexWithinUnit = new Map<string, number>()
    for (const row of sheet.rows) {
      const fullName = getMappedValue(row.values, mapping.fullName)
      const email = getMappedValue(row.values, mapping.email).toLowerCase()
      const phone = getMappedValue(row.values, mapping.phone)
      const unitCode = getMappedValue(row.values, mapping.unitCode)
      const floor = getMappedValue(row.values, mapping.floor) || null
      const relationshipValue = getMappedValue(row.values, mapping.relationship)
      const primaryValue = getMappedValue(row.values, mapping.primary)
      const unitKind = parseUnitKind(getMappedValue(row.values, mapping.unitKind))
      const unitKey = normalizeText(unitCode)
      const existingUnit = unitKey ? existingUnits.get(unitKey) : null
      const currentIndex = unitKey ? (rowIndexWithinUnit.get(unitKey) ?? 0) : 0

      let relationshipType =
        parseRelationshipFromValue(relationshipValue, context) ??
        (parseBoolean(primaryValue) ? 'propietario' : null)

      if (!relationshipType) {
        relationshipType = currentIndex === 0 ? 'vecino_principal' : 'vecino_adicional'
      }

      if (unitKey) {
        rowIndexWithinUnit.set(unitKey, currentIndex + 1)
      }

      rows.push({
        id: `${sheet.name}-${row.sourceRowNumber}-${rows.length + 1}`,
        sourceSheet: sheet.name,
        sourceRowNumber: row.sourceRowNumber,
        status: 'ready',
        statusReason: null,
        confidence: fullName && email && unitCode ? 86 : 58,
        fullName,
        email,
        phone,
        unitCode,
        floor,
        relationshipType,
        isPrimary: relationshipType === 'propietario' ? parseBoolean(primaryValue) : false,
        unitKind,
        existingUnitId: existingUnit?.id ?? null,
        unitDecision: existingUnit ? 'reuse' : unitCode ? 'create' : 'unresolved',
        rawPreview: buildRawPreview(row.values),
      })
    }
  }

  const finalizedRows = finalizeImportRows(rows)

  return {
    buildingId: parsed.buildingId,
    buildingName: String(building.name),
    fileName: parsed.fileName,
    detectedColumns,
    warnings: [...new Set(warnings.filter(Boolean))],
    rows: finalizedRows,
    summary: summarizeImportRows(finalizedRows),
  }
}

export async function confirmInitialOccupancyImport(
  input: z.input<typeof confirmInitialOccupancyImportSchema>,
): Promise<InitialOccupancyImportConfirmResult> {
  const parsed = confirmInitialOccupancyImportSchema.parse(input)
  await requireProfile(['super_admin'])

  const admin = getSupabaseAdminClient()
  if (!admin) {
    throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para confirmar importaciones desde superadmin.')
  }

  const { data: property } = await admin
    .from('iadmin_managed_properties')
    .select('id')
    .eq('building_id', parsed.buildingId)
    .limit(1)
    .maybeSingle()

  if (!property?.id) {
    throw new Error('No existe una propiedad IAdmin para el edificio seleccionado.')
  }

  let createdUsers = 0
  let createdUnits = 0
  let linkedMemberships = 0
  let updatedMemberships = 0
  const errors: string[] = []

  for (const row of parsed.rows as ConfirmableImportRow[]) {
    if (row.status !== 'ready') {
      continue
    }

    try {
      let unitId = row.existingUnitId
      if (!unitId) {
        const { data: existingUnit } = await admin
          .from('iadmin_units')
          .select('id')
          .eq('managed_property_id', property.id)
          .ilike('code', row.unitCode)
          .limit(1)
          .maybeSingle()

        if (existingUnit?.id) {
          unitId = String(existingUnit.id)
        } else {
          const { data: createdUnit, error: unitError } = await admin
            .from('iadmin_units')
            .insert({
              managed_property_id: property.id,
              code: row.unitCode,
              floor: row.floor,
              kind: row.unitKind,
              is_active: true,
            })
            .select('id')
            .single()
          if (unitError || !createdUnit) throw new Error(unitError?.message ?? 'No se pudo crear la unidad.')
          unitId = String(createdUnit.id)
          createdUnits += 1
        }
      }

      const { data: existingProfile } = await admin
        .from('profiles')
        .select('id')
        .eq('email', row.email.toLowerCase())
        .maybeSingle()

      const profileId = await findOrCreatePlatformProfile({
        fullName: row.fullName,
        email: row.email,
        phone: row.phone || null,
        password: 'Citify2026!',
        role: relationshipRole(row.relationshipType),
        buildingId: parsed.buildingId,
      })

      if (!existingProfile?.id) {
        createdUsers += 1
      }

      if (row.relationshipType === 'vecino_principal') {
        await admin
          .from('unit_profile_memberships')
          .update({ active: false })
          .eq('unit_id', unitId)
          .eq('relationship_type', 'vecino_principal')
          .eq('active', true)
      }

      const { data: existingMembership } = await admin
        .from('unit_profile_memberships')
        .select('id')
        .eq('unit_id', unitId)
        .eq('profile_id', profileId)
        .eq('relationship_type', row.relationshipType)
        .maybeSingle()

      const membershipPayload = {
        unit_id: unitId,
        building_id: parsed.buildingId,
        profile_id: profileId,
        relationship_type: row.relationshipType,
        is_primary: row.relationshipType === 'propietario' ? row.isPrimary : false,
        active: true,
      }

      const { error: membershipError } = existingMembership
        ? await admin.from('unit_profile_memberships').update(membershipPayload).eq('id', existingMembership.id)
        : await admin.from('unit_profile_memberships').insert(membershipPayload)
      if (membershipError) throw new Error(membershipError.message)

      if (existingMembership) {
        updatedMemberships += 1
      } else {
        linkedMemberships += 1
      }

      if (row.relationshipType === 'propietario') {
        const { data: existingHolder } = await admin
          .from('iadmin_unit_holders')
          .select('id')
          .eq('unit_id', unitId)
          .eq('profile_id', profileId)
          .eq('holder_kind', 'propietario')
          .maybeSingle()

        if (!existingHolder) {
          const { error: holderError } = await admin.from('iadmin_unit_holders').insert({
            unit_id: unitId,
            profile_id: profileId,
            full_name: row.fullName,
            holder_kind: 'propietario',
            email: row.email.toLowerCase(),
            phone: row.phone || null,
            is_active: true,
          })
          if (holderError) throw new Error(holderError.message)
        }
      }
    } catch (error) {
      errors.push(
        `${row.sourceSheet} línea ${row.sourceRowNumber}: ${error instanceof Error ? error.message : 'Error desconocido'}`,
      )
    }
  }

  revalidatePath('/superadmin')
  revalidatePath('/iadmin')
  return { createdUsers, createdUnits, linkedMemberships, updatedMemberships, errors }
}

const bulkImportInitialOccupancySchema = z.object({
  csv: z.string().trim().min(10),
})

export async function bulkImportInitialOccupancy(input: z.input<typeof bulkImportInitialOccupancySchema>) {
  const parsed = bulkImportInitialOccupancySchema.parse(input)
  await requireProfile(['super_admin'])

  const admin = getSupabaseAdminClient()
  if (!admin) {
    throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para importar usuarios desde superadmin.')
  }

  const rows = parseImportCsv(parsed.csv)
  let createdUnits = 0
  let linkedUsers = 0
  const errors: string[] = []

  for (const { row, line } of rows) {
    try {
      const buildingId = row.building_id || row.buildingId
      const unitCode = row.unit_code || row.unitCode || row.unidad
      const relationship = (row.relationship_type || row.relationshipType || row.relacion) as ImportRelationship
      const fullName = row.full_name || row.fullName || row.nombre
      const email = row.email
      const phone = row.phone || row.telefono || null
      const password = row.password || 'Citify2026!'
      const floor = row.floor || row.piso || null
      const kind = row.unit_kind || row.unitKind || 'departamento'

      if (!buildingId || !unitCode || !relationship || !fullName || !email) {
        throw new Error('Faltan columnas obligatorias: building_id, unit_code, relationship_type, full_name, email.')
      }

      if (!['propietario', 'vecino_principal', 'vecino_adicional'].includes(relationship)) {
        throw new Error(`relationship_type invalido: ${relationship}.`)
      }

      const { data: property } = await admin
        .from('iadmin_managed_properties')
        .select('id')
        .eq('building_id', buildingId)
        .limit(1)
        .maybeSingle()

      if (!property?.id) {
        throw new Error(`No existe una propiedad IAdmin para building_id ${buildingId}.`)
      }

      const { data: existingUnit } = await admin
        .from('iadmin_units')
        .select('id')
        .eq('managed_property_id', property.id)
        .ilike('code', unitCode)
        .limit(1)
        .maybeSingle()

      let unitId = existingUnit?.id as string | undefined
      if (!unitId) {
        const { data: createdUnit, error: unitError } = await admin
          .from('iadmin_units')
          .insert({
            managed_property_id: property.id,
            code: unitCode,
            floor,
            kind,
            is_active: true,
          })
          .select('id')
          .single()
        if (unitError || !createdUnit) throw new Error(unitError?.message ?? 'No se pudo crear la unidad.')
        unitId = createdUnit.id as string
        createdUnits += 1
      }

      const profileId = await findOrCreatePlatformProfile({
        fullName,
        email,
        phone,
        password,
        role: relationshipRole(relationship),
        buildingId,
      })

      if (relationship === 'vecino_principal') {
        await admin
          .from('unit_profile_memberships')
          .update({ active: false })
          .eq('unit_id', unitId)
          .eq('relationship_type', 'vecino_principal')
          .eq('active', true)
      }

      const { data: existingMembership } = await admin
        .from('unit_profile_memberships')
        .select('id')
        .eq('unit_id', unitId)
        .eq('profile_id', profileId)
        .eq('relationship_type', relationship)
        .maybeSingle()

      const membershipPayload = {
        unit_id: unitId,
        building_id: buildingId,
        profile_id: profileId,
        relationship_type: relationship,
        is_primary: relationship === 'propietario' ? parseBoolean(row.is_primary || row.principal) : false,
        active: true,
      }

      const { error: membershipError } = existingMembership
        ? await admin.from('unit_profile_memberships').update(membershipPayload).eq('id', existingMembership.id)
        : await admin.from('unit_profile_memberships').insert(membershipPayload)
      if (membershipError) throw new Error(membershipError.message)

      if (relationship === 'propietario') {
        const { data: existingHolder } = await admin
          .from('iadmin_unit_holders')
          .select('id')
          .eq('unit_id', unitId)
          .eq('profile_id', profileId)
          .eq('holder_kind', 'propietario')
          .maybeSingle()

        if (!existingHolder) {
          await admin.from('iadmin_unit_holders').insert({
            unit_id: unitId,
            profile_id: profileId,
            full_name: fullName,
            holder_kind: 'propietario',
            email: email.toLowerCase(),
            phone,
            is_active: true,
          })
        }
      }

      linkedUsers += 1
    } catch (error) {
      errors.push(`Linea ${line}: ${error instanceof Error ? error.message : 'Error desconocido'}`)
    }
  }

  revalidatePath('/superadmin')
  revalidatePath('/iadmin')
  return { createdUnits, linkedUsers, errors }
}

const createBusinessWithAdminSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  address: z.string().trim().max(200).nullable().optional(),
  adminFullName: z.string().trim().min(2).max(120),
  adminEmail: z.string().trim().email().max(160),
  adminPhone: z.string().trim().max(40).nullable().optional(),
  adminPassword: z.string().min(8).max(72),
})

export async function createBusinessWithAdmin(input: z.input<typeof createBusinessWithAdminSchema>) {
  const parsed = createBusinessWithAdminSchema.parse(input)
  await requireProfile(['super_admin'])

  const admin = getSupabaseAdminClient()
  if (!admin) {
    throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para crear negocios desde superadmin.')
  }

  const { data: business, error: businessError } = await admin
    .from('businesses')
    .insert({
      name: parsed.businessName,
      category: parsed.category,
      description: parsed.description ?? '',
      address: parsed.address ?? null,
    })
    .select('id')
    .single()

  if (businessError || !business) {
    throw new Error(businessError?.message ?? 'No se pudo crear el negocio.')
  }

  const profileId = await findOrCreatePlatformProfile({
    fullName: parsed.adminFullName,
    email: parsed.adminEmail,
    phone: parsed.adminPhone ?? null,
    password: parsed.adminPassword,
    role: 'negocio_admin',
    buildingId: null,
    businessId: business.id,
  })

  await admin.from('businesses').update({ owner_profile_id: profileId }).eq('id', business.id)

  revalidatePath('/superadmin')
  return { businessId: business.id as string, profileId }
}
