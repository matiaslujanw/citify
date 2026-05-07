import Link from 'next/link'
import { Filter, X } from 'lucide-react'

export function ScopedToBuildingBanner({
  propertyName,
  basePath,
}: {
  propertyName: string
  basePath: string
}) {
  return (
    <div className="rounded-full border border-primary/30 bg-primary/5 px-4 py-2 text-sm flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2 text-foreground">
        <Filter className="w-3.5 h-3.5 text-primary" />
        <span>
          Filtrado por edificio: <strong className="font-medium">{propertyName}</strong>
        </span>
      </div>
      <Link
        href={basePath}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <X className="w-3 h-3" />
        Quitar filtro
      </Link>
    </div>
  )
}
