'use client'

import { Building2, Home, Info, ReceiptText, Users } from 'lucide-react'
import type { OwnerDashboardData } from '@/lib/types'
import { Money } from '@/components/admin-backoffice/shared/money'
import { ChatWidget } from '@/components/ai/chat-widget'
import { ReportPaymentDialog } from '@/components/propietario/report-payment-dialog'

function relationshipLabel(value: string) {
  return value.replace('_', ' ')
}

export function OwnerDashboard({ data }: { data: OwnerDashboardData }) {
  const firstName = data.profile.fullName.split(' ')[0]
  const totalDue = data.units.reduce((sum, unit) => sum + (unit.latestLiquidation?.balanceRemaining ?? 0), 0)
  const lastPayment = data.units.flatMap((unit) => unit.payments).sort((a, b) => b.paidAt.localeCompare(a.paidAt))[0]

  return (
    <>
    <div className="mx-auto max-w-6xl px-6 py-8">
      <section className="glass-card rounded-3xl p-6 mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <Home className="w-3.5 h-3.5" />
              Panel propietario
            </div>
            <h1 className="mt-4 font-serif text-3xl font-bold text-foreground">Hola, {firstName}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Este espacio concentra la informacion de tus unidades, liquidaciones, pagos e informacion general del edificio.
            </p>
          </div>
          <div className="rounded-2xl border border-border/50 bg-background px-5 py-4 text-right">
            <div className="text-xs text-muted-foreground">Saldo pendiente estimado</div>
            <div className="mt-1 font-serif text-2xl font-bold text-foreground">
              <Money amount={totalDue} />
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <StatCard icon={Building2} label="Unidades vinculadas" value={data.units.length.toString()} />
        <StatCard icon={ReceiptText} label="Ultimo pago" value={lastPayment ? new Date(lastPayment.paidAt).toLocaleDateString('es-AR') : 'Sin pagos'} />
        <StatCard icon={Info} label="Avisos del edificio" value={data.buildingInformation.length.toString()} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_0.7fr] gap-6">
        <section className="glass-card rounded-3xl overflow-hidden">
          <header className="border-b border-border/40 px-5 py-4">
            <h2 className="font-serif text-xl font-semibold text-foreground">Mis unidades</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Liquidacion y pagos asociados a tu propiedad.</p>
          </header>
          {data.units.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted-foreground">
              Todavia no tenes unidades vinculadas. El administrador debe asociarte como propietario.
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {data.units.map((unit) => (
                <article key={unit.membership.id} className="px-5 py-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-primary">
                        {unit.membership.buildingName ?? 'Edificio'}
                      </div>
                      <h3 className="mt-1 text-lg font-semibold text-foreground">
                        Unidad {unit.membership.unitCode ?? unit.membership.unitId.slice(0, 8)}
                      </h3>
                      <p className="text-xs text-muted-foreground capitalize">
                        {relationshipLabel(unit.membership.relationshipType)}
                        {unit.membership.isPrimary ? ' principal' : ''}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-muted/50 px-4 py-3 text-right">
                      <div className="text-xs text-muted-foreground">Pendiente</div>
                      <div className="font-semibold text-foreground">
                        <Money amount={unit.latestLiquidation?.balanceRemaining ?? 0} />
                      </div>
                    </div>
                  </div>

                  {unit.latestLiquidation ? (
                    <>
                      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <MiniMetric label="Ordinaria" value={<Money amount={unit.latestLiquidation.ordinaryAmount} />} />
                        <MiniMetric label="Extraordinaria" value={<Money amount={unit.latestLiquidation.extraordinaryAmount} />} />
                        <MiniMetric label="Saldo anterior" value={<Money amount={unit.latestLiquidation.previousBalance} />} />
                        <MiniMetric label="Total" value={<Money amount={unit.latestLiquidation.subtotal} />} />
                      </div>
                      {unit.latestLiquidation.balanceRemaining > 0 ? (
                        <div className="mt-3 flex justify-end">
                          <ReportPaymentDialog
                            liquidationItemId={unit.latestLiquidation.id}
                            unitCode={unit.membership.unitCode ?? unit.membership.unitId.slice(0, 8)}
                            balanceRemaining={unit.latestLiquidation.balanceRemaining}
                          />
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="mt-4 rounded-2xl border border-dashed border-border/50 p-4 text-sm text-muted-foreground">
                      Todavia no hay liquidaciones emitidas para esta unidad.
                    </p>
                  )}

                  {unit.payments.length > 0 ? (
                    <div className="mt-4">
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Ultimos pagos</div>
                      <div className="space-y-2">
                        {unit.payments.slice(0, 3).map((payment) => (
                          <div key={payment.id} className="flex items-center justify-between rounded-xl bg-background px-3 py-2 text-sm">
                            <span className="text-muted-foreground">{new Date(payment.paidAt).toLocaleDateString('es-AR')}</span>
                            <span className="font-medium text-foreground"><Money amount={payment.amount} /></span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <section className="glass-card rounded-3xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Info className="w-4 h-4 text-primary" />
              <h2 className="font-serif text-lg font-semibold text-foreground">Informacion del edificio</h2>
            </div>
            {data.buildingInformation.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                El administrador todavia no cargo horarios, normas o contactos generales.
              </p>
            ) : (
              <div className="space-y-3">
                {data.buildingInformation.map((item) => (
                  <article key={item.id} className="rounded-2xl border border-border/40 bg-background p-3">
                    <div className="text-[11px] uppercase tracking-wide text-primary">{item.category}</div>
                    <h3 className="mt-1 font-medium text-foreground">{item.title}</h3>
                    <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{item.content}</p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="glass-card rounded-3xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-primary" />
              <h2 className="font-serif text-lg font-semibold text-foreground">Asambleas y voto</h2>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              El modelo ya distingue al propietario de los vecinos. En la proxima etapa, este panel va a centralizar asambleas y votaciones por unidad.
            </p>
          </section>
        </aside>
      </div>
    </div>

      <ChatWidget
        suggestions={[
          '¿Cuánto debo de expensas?',
          '¿Cuál fue mi último pago?',
          '¿Hay avisos del edificio?',
          '¿Cuáles son mis unidades?',
        ]}
        welcomeText="Puedo responder preguntas sobre tus expensas, pagos y avisos de tu edificio."
      />
    </>
  )
}

function StatCard({ icon: Icon, label, value }: { icon: typeof Home; label: string; value: string }) {
  return (
    <div className="glass-card rounded-2xl p-5">
      <Icon className="w-5 h-5 text-primary mb-3" />
      <div className="text-2xl font-bold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

function MiniMetric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-background px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-medium text-foreground">{value}</div>
    </div>
  )
}
