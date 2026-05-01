'use client'

import { useState } from 'react'

const API_URL = ''

interface AuditEvent {
  id?: string
  event_type?: string
  action?: string
  resource?: string
  tenant_id?: string
  tenant?: string
  status?: string
  severity?: string
  timestamp?: string
  created_at?: string
  ip_address?: string
  user_agent?: string
  [key: string]: unknown
}

type ReportType = 'soc2' | 'dpdpa'

interface Props {
  reportType: ReportType
  label?: string
}

export default function DownloadReportButton({ reportType, label }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reportTitle = reportType === 'soc2' ? 'SOC 2 Compliance Report' : 'DPDPA Compliance Report'
  const fileName = `tinai-${reportType}-report-${new Date().toISOString().slice(0, 10)}.pdf`

  async function handleDownload() {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/audit-events?limit=1000`)
      let events: AuditEvent[] = []
      if (res.ok) {
        const data = await res.json()
        events = Array.isArray(data) ? data : (data.events ?? data.items ?? data.results ?? [])
      }

      // Dynamically import jsPDF to keep it client-side only
      const { jsPDF } = await import('jspdf')
      const autoTable = (await import('jspdf-autotable')).default

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pageWidth = doc.internal.pageSize.getWidth()
      const today = new Date().toISOString().slice(0, 10)

      // Header bar
      doc.setFillColor(15, 23, 42) // slate-900
      doc.rect(0, 0, pageWidth, 28, 'F')

      // Title
      doc.setTextColor(248, 250, 252) // slate-50
      doc.setFontSize(16)
      doc.setFont('helvetica', 'bold')
      doc.text('Tinai Cloud', 14, 11)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.text(reportTitle, 14, 20)

      // Meta row
      doc.setTextColor(100, 116, 139) // slate-500
      doc.setFontSize(8)
      doc.text(`Generated: ${today}`, 14, 35)
      doc.text(`Company: Tinai Cloud  |  Report type: ${reportType.toUpperCase()}`, 14, 41)
      doc.text(`Total audit events: ${events.length}`, 14, 47)

      // Divider
      doc.setDrawColor(51, 65, 85) // slate-700
      doc.line(14, 51, pageWidth - 14, 51)

      // Summary section heading
      doc.setTextColor(30, 41, 59) // slate-800
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.text('Audit Events', 14, 60)

      if (events.length === 0) {
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9)
        doc.setTextColor(100, 116, 139)
        doc.text('No audit events found. Ensure the control-plane API is reachable.', 14, 70)
      } else {
        const tableRows = events.slice(0, 500).map((e) => [
          String(e.timestamp ?? e.created_at ?? '—').slice(0, 19).replace('T', ' '),
          String(e.event_type ?? e.action ?? '—'),
          String(e.resource ?? '—'),
          String(e.tenant_id ?? e.tenant ?? '—'),
          String(e.status ?? e.severity ?? '—'),
          String(e.ip_address ?? '—'),
        ])

        autoTable(doc, {
          startY: 65,
          head: [['Timestamp', 'Event', 'Resource', 'Tenant', 'Status', 'IP']],
          body: tableRows,
          styles: {
            fontSize: 7,
            cellPadding: 2,
            textColor: [30, 41, 59],
            lineColor: [203, 213, 225],
            lineWidth: 0.1,
          },
          headStyles: {
            fillColor: [15, 23, 42],
            textColor: [248, 250, 252],
            fontStyle: 'bold',
            fontSize: 7,
          },
          alternateRowStyles: { fillColor: [248, 250, 252] },
          margin: { left: 14, right: 14 },
        })
      }

      // Footer on each page
      const totalPages = (doc.internal as unknown as { getNumberOfPages: () => number }).getNumberOfPages()
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i)
        doc.setFontSize(7)
        doc.setTextColor(148, 163, 184)
        doc.text(
          `Tinai Cloud — ${reportTitle} — ${today}  |  Page ${i} of ${totalPages}`,
          pageWidth / 2,
          doc.internal.pageSize.getHeight() - 6,
          { align: 'center' }
        )
      }

      doc.save(fileName)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to generate report')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={handleDownload}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 hover:border-slate-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
            Generating PDF…
          </>
        ) : (
          <>
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            {label ?? 'Download Report'}
          </>
        )}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
