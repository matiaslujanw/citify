import { notFound } from 'next/navigation'
import { ConsorcioSubNav } from '@/components/admin-backoffice/consorcio/consorcio-subnav'
import { requireIAdmin } from '@/lib/auth'
import { getIAdminConsorcioDetail } from '@/lib/data'

export default async function ConsorcioLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  await requireIAdmin({ capability: 'consorcio.view' })

  const detail = await getIAdminConsorcioDetail(id)
  if (!detail) {
    notFound()
  }

  return (
    <div className="space-y-6">
      <ConsorcioSubNav
        propertyName={detail.property.displayName ?? detail.property.buildingName}
        propertyAddress={detail.property.buildingAddress}
      />
      {children}
    </div>
  )
}
