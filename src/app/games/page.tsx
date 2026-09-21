import type { Metadata } from 'next'
import GamesView from '@/components/hyperion/GamesView'

export const metadata: Metadata = {
  title: 'HYPERION games',
  description: 'games for Hyperion.',
}

type GamesPageProps = {
  searchParams: Promise<{ tab?: string }>
}

export default async function GamesPage({ searchParams }: GamesPageProps) {
  const params = await searchParams
  const initialTab = params.tab === 'browse' ? 'browse' : 'games'
  return <GamesView initialTab={initialTab} />
}
