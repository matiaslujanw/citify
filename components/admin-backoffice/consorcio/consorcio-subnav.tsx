import { Building2 } from 'lucide-react'

export function ConsorcioSubNav({
  propertyName,
  propertyAddress,
}: {
  propertyName: string
  propertyAddress: string
}) {
  return (
    <div className="glass-card rounded-2xl px-5 py-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Building2 className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-primary font-medium">Edificio</p>
          <h1 className="font-serif text-lg font-bold text-foreground truncate leading-tight">{propertyName}</h1>
          {propertyAddress ? (
            <p className="text-xs text-muted-foreground truncate">{propertyAddress}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
