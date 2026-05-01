'use client'

import dynamic from 'next/dynamic'
import { Satellite } from '@/lib/api'

const GlobeInner = dynamic(() => import('./GlobeInner'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[480px] rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center">
      <span className="text-slate-500 text-sm">Loading globe…</span>
    </div>
  ),
})

export default function GlobeViewer({ satellites }: { satellites: Satellite[] }) {
  return <GlobeInner satellites={satellites} />
}
