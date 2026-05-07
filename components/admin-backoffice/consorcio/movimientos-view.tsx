'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Loader2, Pencil, Plus, Repeat, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Money } from '@/components/admin-backoffice/shared/money'
import {
  addExpenseLine,
  replicatePreviousMonth,
  upsertMonthlyCell,
} from '@/app/iadmin/consorcios/[id]/planilla/actions'
import type { IAdminMonthlyGrid, IAdminMonthlyGridRow } from '@/lib/types'

type Props = {
  grid: IAdminMonthlyGrid
  canManageRubros: boolean
}

type LineRow = {
  providerId: string
  providerName: string
  isRecurring: boolean
  expenseKind: 'ordinaria' | 'extraordinaria'
  amount: number | null
  lastAmount: number | null
  isEditable: boolean
}

const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

// Formato pesos argentinos: separador de miles con punto, decimal con coma.
// Ej: 50000 → "50.000"  ·  1234567.5 → "1.234.567,5"
function formatARSInput(raw: string): string {
  const cleaned = raw.replace(/[^\d,]/g, '')
  if (!cleaned) return ''
  const [intPart, decPart] = cleaned.split(',')
  const withThousands = (intPart || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return decPart !== undefined ? `${withThousands},${decPart}` : withThousands
}

function parseARSInput(formatted: string): number | null {
  const trimmed = formatted.trim()
  if (!trimmed) return null
  const normalized = trimmed.replace(/\./g, '').replace(',', '.')
  const n = Number(normalized)
  return Number.isNaN(n) ? null : n
}

function formatNumberToInput(n: number | null | undefined): string {
  if (n == null) return ''
  return formatARSInput(String(n).replace('.', ','))
}

export function MovimientosView({ grid, canManageRubros }: Props) {
  const router = useRouter()
  const currentMonth = grid.months[grid.months.length - 1]
  const monthLabel = `${MONTHS_ES[currentMonth.month - 1]} ${currentMonth.year}`

  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [showAddFixed, setShowAddFixed] = useState(false)
  const [showAddEventual, setShowAddEventual] = useState(false)

  const rows: LineRow[] = useMemo(() => {
    return grid.rows.map((r: IAdminMonthlyGridRow) => {
      const cell = r.cells.find((c) => c.year === currentMonth.year && c.month === currentMonth.month)
      return {
        providerId: r.providerId,
        providerName: r.providerName,
        isRecurring: r.isRecurring,
        expenseKind: r.expenseKind,
        amount: cell?.amount ?? null,
        lastAmount: r.lastAmount,
        isEditable: cell?.isEditable ?? true,
      }
    })
  }, [grid, currentMonth])

  const fixedRows = rows.filter((r) => r.isRecurring)
  const eventualRows = rows.filter((r) => !r.isRecurring)

  const totalFijos = fixedRows.reduce((acc, r) => acc + (r.amount ?? 0), 0)
  const totalEventuales = eventualRows.reduce((acc, r) => acc + (r.amount ?? 0), 0)
  const totalGeneral = totalFijos + totalEventuales

  async function handleSaveAmount(row: LineRow, newAmount: number | null) {
    if (newAmount === row.amount) return
    setSavingKey(row.providerId)
    try {
      await upsertMonthlyCell({
        propertyId: grid.propertyId,
        providerId: row.providerId,
        year: currentMonth.year,
        month: currentMonth.month,
        amount: newAmount,
        expenseKind: row.expenseKind,
      })
      startTransition(() => router.refresh())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar')
    } finally {
      setSavingKey(null)
    }
  }

  async function handleDelete(row: LineRow) {
    if (!confirm(`¿Borrar el gasto "${row.providerName}" del mes?`)) return
    await handleSaveAmount(row, null)
  }

  async function handleReplicate() {
    setSavingKey('__replicate__')
    try {
      const { replicated } = await replicatePreviousMonth({
        propertyId: grid.propertyId,
        year: currentMonth.year,
        month: currentMonth.month,
      })
      if (replicated > 0) {
        toast.success(`Se replicaron ${replicated} gastos fijos del mes anterior.`)
      } else {
        toast.info('No había gastos fijos del mes anterior para replicar.')
      }
      startTransition(() => router.refresh())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo replicar')
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-primary font-medium">Movimientos</p>
          <h2 className="font-serif text-2xl font-bold text-foreground mt-0.5">{monthLabel}</h2>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Total del mes</p>
            <p className="font-serif text-xl font-bold text-foreground"><Money amount={totalGeneral} /></p>
          </div>
        </div>
      </header>

      <Section
        title="Gastos fijos"
        subtitle="Se repiten todos los meses (luz, encargado, mantenimiento…)"
        total={totalFijos}
        actions={
          canManageRubros ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={handleReplicate}
                disabled={savingKey === '__replicate__'}
              >
                {savingKey === '__replicate__' ? (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                ) : (
                  <Repeat className="w-4 h-4 mr-1.5" />
                )}
                Replicar mes anterior
              </Button>
              <Button size="sm" onClick={() => setShowAddFixed((v) => !v)}>
                <Plus className="w-4 h-4 mr-1.5" />
                Agregar
              </Button>
            </>
          ) : null
        }
      >
        {showAddFixed ? (
          <AddLineForm
            grid={grid}
            isRecurring
            onClose={() => setShowAddFixed(false)}
            onSaved={() => {
              setShowAddFixed(false)
              startTransition(() => router.refresh())
            }}
          />
        ) : null}
        {fixedRows.length === 0 ? (
          <EmptyRow text="Todavía no cargaste gastos fijos." />
        ) : (
          <ul className="divide-y divide-border/40">
            {fixedRows.map((row) => (
              <LineItem
                key={row.providerId}
                row={row}
                saving={savingKey === row.providerId || pending}
                onSave={handleSaveAmount}
                onDelete={canManageRubros ? handleDelete : undefined}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Egresos eventuales"
        subtitle="Gastos puntuales (limpieza salón, compra de bolsas, tareas extras…)"
        total={totalEventuales}
        actions={
          canManageRubros ? (
            <Button size="sm" onClick={() => setShowAddEventual((v) => !v)}>
              <Plus className="w-4 h-4 mr-1.5" />
              Agregar
            </Button>
          ) : null
        }
      >
        {showAddEventual ? (
          <AddLineForm
            grid={grid}
            isRecurring={false}
            onClose={() => setShowAddEventual(false)}
            onSaved={() => {
              setShowAddEventual(false)
              startTransition(() => router.refresh())
            }}
          />
        ) : null}
        {eventualRows.length === 0 ? (
          <EmptyRow text="Sin egresos eventuales este mes." />
        ) : (
          <ul className="divide-y divide-border/40">
            {eventualRows.map((row) => (
              <LineItem
                key={row.providerId}
                row={row}
                saving={savingKey === row.providerId || pending}
                onSave={handleSaveAmount}
                onDelete={canManageRubros ? handleDelete : undefined}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function Section({
  title,
  subtitle,
  total,
  actions,
  children,
}: {
  title: string
  subtitle: string
  total: number
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="glass-card rounded-2xl overflow-hidden">
      <header className="px-5 py-4 flex items-start justify-between gap-3 flex-wrap border-b border-border/40">
        <div className="min-w-0">
          <h3 className="font-serif text-lg font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-right pr-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Subtotal</p>
            <p className="font-serif text-base font-semibold text-foreground"><Money amount={total} /></p>
          </div>
          {actions}
        </div>
      </header>
      <div>{children}</div>
    </section>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <p className="px-5 py-6 text-sm text-muted-foreground text-center">{text}</p>
}

function LineItem({
  row,
  saving,
  onSave,
  onDelete,
}: {
  row: LineRow
  saving: boolean
  onSave: (row: LineRow, amount: number | null) => Promise<void>
  onDelete?: (row: LineRow) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(formatNumberToInput(row.amount))

  function startEdit() {
    setDraft(formatNumberToInput(row.amount))
    setEditing(true)
  }

  function cancelEdit() {
    setDraft(formatNumberToInput(row.amount))
    setEditing(false)
  }

  async function commit() {
    if (draft.trim() === '') {
      await onSave(row, null)
      setEditing(false)
      return
    }
    const n = parseARSInput(draft)
    if (n == null || n < 0) {
      toast.error('Monto inválido')
      return
    }
    await onSave(row, n)
    setEditing(false)
  }

  return (
    <li className="px-5 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate">{row.providerName}</p>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${
            row.expenseKind === 'extraordinaria'
              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
              : 'bg-muted text-muted-foreground'
          }`}>
            {row.expenseKind === 'extraordinaria' ? 'Extraord.' : 'Ordinaria'}
          </span>
          {row.lastAmount != null && row.amount == null ? (
            <span className="inline-flex items-center gap-1">
              <Copy className="w-3 h-3" />
              último: <Money amount={row.lastAmount} />
            </span>
          ) : null}
        </div>
      </div>

      {editing ? (
        <>
          <div className="w-40 relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">$</span>
            <Input
              autoFocus
              inputMode="decimal"
              placeholder="0"
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(formatARSInput(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commit()
                } else if (e.key === 'Escape') {
                  cancelEdit()
                }
              }}
              className="pl-6 text-right tabular-nums"
            />
          </div>
          <Button size="icon" variant="ghost" onClick={() => void commit()} disabled={saving} title="Guardar">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4 text-emerald-600" />}
          </Button>
          <Button size="icon" variant="ghost" onClick={cancelEdit} disabled={saving} title="Cancelar">
            <X className="w-4 h-4 text-muted-foreground" />
          </Button>
        </>
      ) : (
        <>
          <div className="w-40 text-right tabular-nums font-medium text-foreground">
            {row.amount != null ? <Money amount={row.amount} /> : <span className="text-muted-foreground">—</span>}
          </div>
          <Button
            size="icon"
            variant="ghost"
            disabled={!row.isEditable || saving}
            onClick={startEdit}
            title="Editar monto"
          >
            <Pencil className="w-4 h-4 text-muted-foreground" />
          </Button>
        </>
      )}

      {!editing && onDelete ? (
        <Button
          size="icon"
          variant="ghost"
          disabled={saving || !row.isEditable || row.amount == null}
          onClick={() => void onDelete(row)}
          title="Borrar línea del mes"
        >
          <Trash2 className="w-4 h-4 text-muted-foreground" />
        </Button>
      ) : null}
    </li>
  )
}

function AddLineForm({
  grid,
  isRecurring,
  onClose,
  onSaved,
}: {
  grid: IAdminMonthlyGrid
  isRecurring: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const currentMonth = grid.months[grid.months.length - 1]
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<'ordinaria' | 'extraordinaria'>('ordinaria')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      toast.error('Poné un nombre')
      return
    }
    const numAmount = amount.trim() === '' ? null : parseARSInput(amount)
    if (numAmount !== null && (numAmount === null || numAmount < 0)) {
      toast.error('Monto inválido')
      return
    }
    setSubmitting(true)
    try {
      await addExpenseLine({
        propertyId: grid.propertyId,
        administrationId: grid.administrationId,
        name: name.trim(),
        amount: numAmount,
        kind,
        isRecurring,
        year: currentMonth.year,
        month: currentMonth.month,
      })
      toast.success(isRecurring ? 'Gasto fijo agregado' : 'Egreso agregado')
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo agregar')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="px-5 py-4 bg-muted/20 border-b border-border/40 grid grid-cols-1 md:grid-cols-12 gap-3">
      <div className="md:col-span-5 space-y-1">
        <Label className="text-xs">Nombre</Label>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isRecurring ? 'Ej: Luz, Encargado, Ascensor' : 'Ej: Limpieza salón'}
        />
      </div>
      <div className="md:col-span-3 space-y-1">
        <Label className="text-xs">Monto</Label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">$</span>
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(formatARSInput(e.target.value))}
            placeholder="0"
            className="pl-6 text-right tabular-nums"
          />
        </div>
      </div>
      <div className="md:col-span-2 space-y-1">
        <Label className="text-xs">Tipo</Label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'ordinaria' | 'extraordinaria')}
          className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="ordinaria">Ordinaria</option>
          <option value="extraordinaria">Extraordinaria</option>
        </select>
      </div>
      <div className="md:col-span-2 flex items-end gap-2">
        <Button type="submit" size="sm" disabled={submitting} className="flex-1">
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Guardar'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={submitting}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
