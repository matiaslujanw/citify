import { redirect } from 'next/navigation'

export default async function ConsorcioRootPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/iadmin/consorcios/${id}/resumen`)
}
