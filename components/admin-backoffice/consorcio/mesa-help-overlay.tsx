'use client'

import { Command, Keyboard, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Shortcut = {
  keys: string[]
  label: string
  hint?: string
}

type Section = {
  title: string
  icon: typeof Command
  shortcuts: Shortcut[]
}

const SECTIONS: Section[] = [
  {
    title: 'Globales',
    icon: Command,
    shortcuts: [
      { keys: ['⌘', 'K'], label: 'Paleta de comandos', hint: 'buscar + ejecutar cualquier cosa' },
      { keys: ['⌘', 'Z'], label: 'Deshacer última edición' },
      { keys: ['⌘', '⇧', 'Z'], label: 'Rehacer' },
      { keys: ['?'], label: 'Mostrar este panel' },
      { keys: ['/'], label: 'Buscar rubro en la planilla' },
      { keys: ['A'], label: 'Abrir asistente IA' },
      { keys: ['N'], label: 'Agregar rubro' },
      { keys: ['E'], label: 'Emitir y avisar' },
      { keys: ['Esc'], label: 'Cerrar / cancelar' },
    ],
  },
  {
    title: 'En la planilla',
    icon: Keyboard,
    shortcuts: [
      { keys: ['↑', '↓', '←', '→'], label: 'Mover entre celdas' },
      { keys: ['Enter'], label: 'Editar celda · en edit: confirmar y bajar' },
      { keys: ['Tab'], label: 'Confirmar y mover lateralmente' },
      { keys: ['Shift', 'Tab'], label: 'Confirmar y mover a la izquierda' },
      { keys: ['F2'], label: 'Editar celda focuseada' },
      { keys: ['0-9'], label: 'Tipá un número y entra directo a editar' },
      { keys: ['Del', 'Backspace'], label: 'Limpiar valor · si hay selección, limpia todas' },
      { keys: ['⌘', 'V'], label: 'Pegar número · rango si copiaste varios de Excel' },
      { keys: ['Esc'], label: 'Cancelar edición · deseleccionar' },
      { keys: ['Hover'], label: 'Ver historial · factura · quién la cargó' },
    ],
  },
  {
    title: 'Selección múltiple',
    icon: Keyboard,
    shortcuts: [
      { keys: ['click', 'arrastrar'], label: 'Seleccionar rectángulo con el mouse' },
      { keys: ['Shift', 'click'], label: 'Extender desde la celda activa hasta acá' },
      { keys: ['Shift', '↑↓←→'], label: 'Extender selección con flechas' },
      { keys: ['⌘', 'click'], label: 'Agregar / quitar celda individual' },
      { keys: ['⌘', 'C'], label: 'Copiar selección al portapapeles (pegá en Excel)' },
      { keys: ['Del'], label: 'Limpiar todas las celdas seleccionadas' },
      { keys: ['Barra'], label: 'Aplicar delta: +10%  ·  *1.05  ·  =50000  ·  +500' },
    ],
  },
  {
    title: 'Atajos IA',
    icon: Sparkles,
    shortcuts: [
      { keys: ['Arrastrar archivo'], label: 'Suelto en la Mesa para extraer factura' },
    ],
  },
]

export function MesaHelpOverlay({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">Atajos de teclado</DialogTitle>
          <DialogDescription>
            Todo lo que podés hacer sin tocar el mouse.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          {SECTIONS.map((section) => {
            const Icon = section.icon
            return (
              <section key={section.title}>
                <header className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-lg kpi-icon-disc flex items-center justify-center shrink-0">
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <h4 className="font-serif text-sm font-semibold text-foreground">{section.title}</h4>
                </header>
                <ul className="space-y-1">
                  {section.shortcuts.map((s, i) => (
                    <li
                      key={i}
                      className="flex items-start justify-between gap-3 py-1.5 px-2 rounded-md hover:bg-muted/20 text-sm"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="text-foreground">{s.label}</span>
                        {s.hint ? (
                          <span className="text-[11px] text-muted-foreground ml-1.5">· {s.hint}</span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {s.keys.map((k, j) => (
                          <KeyCap key={j}>{k}</KeyCap>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>

        <p className="mt-4 text-[11px] text-muted-foreground text-center italic">
          Los atajos no funcionan cuando estás escribiendo en un campo de texto.
        </p>
      </DialogContent>
    </Dialog>
  )
}

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded-md border border-border/60 bg-muted/40 text-[11px] font-medium text-foreground shadow-[0_1px_0_rgba(92,58,30,0.06)]">
      {children}
    </kbd>
  )
}
