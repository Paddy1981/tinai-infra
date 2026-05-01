'use client'

import { useEffect, useRef } from 'react'
import { Satellite } from '@/lib/api'

// Log-compress orbital altitude into Globe.gl units [0..0.5]
// LEO ~400 km → ~0.10, GEO ~35786 km → 0.50
function toGlobeAlt(altKm: number): number {
  if (altKm <= 0) return 0.02
  const maxRef = Math.log1p(35786 / 400)
  return Math.max(0.02, 0.5 * Math.log1p(altKm / 400) / maxRef)
}

function countryColor(country: string): string {
  const c = country.toUpperCase()
  if (c === 'INDIA' || c === 'IN') return '#10b981'  // emerald
  if (c === 'USA' || c === 'US') return '#3b82f6'    // blue
  if (c === 'EU' || c === 'EUROPE') return '#8b5cf6' // violet
  if (c === 'JAPAN' || c === 'JP') return '#f59e0b'  // amber
  return '#6b7280'
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = reject
    document.head.appendChild(s)
  })
}

export default function GlobeInner({ satellites }: { satellites: Satellite[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      // Load satellite.js and Globe.gl from CDN (same approach as sattrack-web)
      await injectScript('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js')
      await injectScript('https://unpkg.com/globe.gl@2.28.0/dist/globe.gl.min.js')
      if (cancelled || !containerRef.current) return

      const sat = (window as any).satellite
      const Globe = (window as any).Globe

      // Parse TLE records for satellites that have TLE data
      const parsed = satellites
        .filter(s => s.tle_line1 && s.tle_line2)
        .map(s => {
          try {
            return { ...s, satrec: sat.twoline2satrec(s.tle_line1!, s.tle_line2!) }
          } catch {
            return null
          }
        })
        .filter(Boolean) as Array<Satellite & { satrec: any }>

      // Init Globe.gl
      const globe = Globe()
        .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
        .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
        .backgroundColor('rgba(0,0,0,0)')
        .pointsData([])
        .pointAltitude('alt')
        .pointColor('color')
        .pointRadius(0.5)
        .pointLabel((d: any) =>
          `<div style="background:#1e293b;padding:5px 10px;border-radius:6px;font-size:12px;color:#e2e8f0;border:1px solid #334155">` +
          `<b>${d.name}</b><br/>${d.country} · NORAD ${d.norad_id}</div>`
        )
        (containerRef.current)

      globe.controls().autoRotate = true
      globe.controls().autoRotateSpeed = 0.4

      // Propagate satellite positions using SGP4
      function tick() {
        if (cancelled) return
        const now = new Date()
        const gmst = sat.gstime(now)
        const cg = Math.cos(gmst)
        const sg = Math.sin(gmst)

        const pts = parsed.flatMap(s => {
          try {
            const pv = sat.propagate(s.satrec, now)
            if (!pv?.position || pv.position === false) return []
            const { x, y, z } = pv.position
            if (isNaN(x) || isNaN(y) || isNaN(z)) return []

            // ECI → ECEF
            const xf = cg * x + sg * y
            const yf = -sg * x + cg * y
            const R = Math.sqrt(xf * xf + yf * yf + z * z)
            if (!R) return []

            const lat = Math.asin(Math.max(-1, Math.min(1, z / R))) * 180 / Math.PI
            const lng = Math.atan2(yf, xf) * 180 / Math.PI

            return [{
              norad_id: s.norad_id,
              name: s.name,
              country: s.country,
              lat,
              lng,
              alt: toGlobeAlt(R - 6371),
              color: countryColor(s.country),
            }]
          } catch {
            return []
          }
        })

        globe.pointsData(pts)
        timerRef.current = setTimeout(tick, 5000)
      }

      tick()
    }

    init()

    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [satellites])

  return (
    <div
      ref={containerRef}
      className="w-full h-[480px] rounded-lg overflow-hidden"
      style={{ background: 'rgb(2 6 23)' }}
    />
  )
}
