import { FastifyInstance } from 'fastify'
import { writeAuditEvent } from '../utils/audit'

type Jurisdiction = 'IN' | 'QA' | 'AE'

interface DpaRecordRow {
  id: string
  tenant_id: string
  jurisdiction: string
  version: string
  signatory_name: string
  signatory_email: string
  signed_at: string
  pdf_hash: string | null
  pdf_path: string | null
}

interface DpaStatusEntry {
  signed: boolean
  signed_at: string | null
  version: string | null
}

interface DpaStatusResult {
  IN: DpaStatusEntry
  QA: DpaStatusEntry
  AE: DpaStatusEntry
}

interface SignDpaBody {
  tenant_id: string
  jurisdiction: string
  version?: string
  signatory_name: string
  signatory_email: string
}

// DPA template text constants — production versions will be full legal documents.
const DPA_TEMPLATES: Record<Jurisdiction, string> = {
  IN: `DATA PROCESSING AGREEMENT — INDIA (DPDP ACT 2023)

This Data Processing Agreement ("Agreement") is entered into between Tinai Cloud Private Limited ("Data Fiduciary") and the Tenant ("Data Processor") under the Digital Personal Data Protection Act, 2023 (India).

1. SCOPE AND PURPOSE
The Processor agrees to process personal data solely for the purposes of providing the Tinai Cloud PaaS platform services as described in the Master Services Agreement.

2. DATA PROTECTION OBLIGATIONS
The Processor shall implement appropriate technical and organisational measures to ensure a level of security appropriate to the risk, including encryption at rest and in transit, access controls, and regular security reviews.

3. DATA LOCALISATION
All processing of personal data of Indian data principals shall occur within the territory of India, on infrastructure located in Indian data centres, in compliance with Section 16 of the DPDP Act 2023.

4. SUB-PROCESSORS
The Processor may engage the following sub-processors: PostgreSQL (in-cluster, India), Forgejo (in-cluster, India), Kaniko (in-cluster, India). Any engagement of additional sub-processors requires prior written consent from the Data Fiduciary.

5. DATA SUBJECT RIGHTS
The Processor shall assist the Data Fiduciary in fulfilling data principal rights under Chapter III of the DPDP Act 2023, including rights of access, correction, erasure, and grievance redressal.

6. BREACH NOTIFICATION
In the event of a personal data breach, the Processor shall notify the Data Fiduciary within 24 hours of detection. Notification to the Data Protection Board of India shall be made within 72 hours.

7. TERM AND TERMINATION
This Agreement remains in force for the duration of the Master Services Agreement. Upon termination, the Processor shall delete or return all personal data within 30 days.`,

  QA: `DATA PROCESSING AGREEMENT — QATAR (PDPPL 2016)

This Data Processing Agreement ("Agreement") is entered into between Tinai Cloud ("Controller") and the Tenant ("Processor") under the Personal Data Privacy Protection Law No. 13 of 2016 (Qatar).

1. SCOPE AND PURPOSE
Processing of personal data shall be limited to the purposes specified in the Master Services Agreement and shall not be used for any other purpose without prior written consent.

2. LEGAL BASIS FOR PROCESSING
Processing is lawful under Article 6 of PDPPL 2016 on the basis of: (a) performance of a contract to which the data subject is party; (b) compliance with a legal obligation; (c) consent where required.

3. DATA PROTECTION MEASURES
The Processor shall implement security measures as required under Article 19 of PDPPL 2016, including logical access controls, audit logging, and data minimisation practices.

4. CROSS-BORDER TRANSFERS
Transfers of personal data outside Qatar are prohibited unless the destination country provides an adequate level of protection as determined by the Ministry of Transport and Communications, or appropriate safeguards are in place.

5. DATA SUBJECT RIGHTS
The Processor shall support the Controller in fulfilling rights of access, rectification, and objection as provided under Articles 8–12 of PDPPL 2016.

6. BREACH NOTIFICATION
Personal data breaches shall be reported to the Ministry of Transport and Communications within 72 hours of discovery in accordance with PDPPL 2016 guidelines.

7. GOVERNING LAW
This Agreement is governed by the laws of the State of Qatar. Disputes shall be resolved in Qatari courts.`,

  AE: `DATA PROCESSING AGREEMENT — UAE (PDPL 2021)

This Data Processing Agreement ("Agreement") is entered into between Tinai Cloud ("Controller") and the Tenant ("Processor") under the Federal Decree-Law No. 45 of 2021 on Personal Data Protection (UAE PDPL).

1. SCOPE AND PURPOSE
Personal data shall be processed only for specified, explicit and legitimate purposes in accordance with Article 5 of the UAE PDPL. The Processor shall not process data beyond the scope defined in the Master Services Agreement.

2. LAWFUL BASIS
Processing is conducted on the following bases under Article 7: (a) performance of contract; (b) legitimate interests of the Controller where not overridden by data subject interests; (c) explicit consent for sensitive data categories.

3. DATA SECURITY
The Processor shall implement technical and organisational security measures in accordance with Article 16 of the UAE PDPL, including encryption, pseudonymisation, and periodic security assessments.

4. INTERNATIONAL DATA TRANSFERS
Cross-border transfer of personal data shall comply with Article 22 of the UAE PDPL. Transfers are permitted to jurisdictions with adequate protection or under standard contractual clauses approved by the UAE Data Office.

5. DATA SUBJECT RIGHTS
The Processor shall assist the Controller in responding to requests from data subjects exercising rights under Chapter 4 of the UAE PDPL (access, rectification, deletion, restriction, portability, objection).

6. BREACH NOTIFICATION
Data breaches shall be reported to the UAE Data Office within 72 hours and to affected data subjects without undue delay where the breach is likely to result in high risk.

7. GOVERNING LAW AND JURISDICTION
This Agreement is governed by UAE federal law. Disputes shall be resolved under the jurisdiction of UAE courts or the DIFC Courts as agreed between the parties.`,
}

export async function dpaRoutes(app: FastifyInstance) {
  // GET /compliance/dpa/status/:tenantId — DPA signing status, enforce ownership
  app.get<{ Params: { tenantId: string } }>('/compliance/dpa/status/:tenantId', async (req, reply) => {
    const callerTenantId = (req as any).tenantId as string
    if (req.params.tenantId !== callerTenantId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const { rows } = await app.pg.query<DpaRecordRow>(
      `SELECT DISTINCT ON (jurisdiction)
         jurisdiction, version, signed_at
       FROM dpa_records
       WHERE tenant_id = $1
       ORDER BY jurisdiction, signed_at DESC`,
      [callerTenantId],
    )

    const byJurisdiction = new Map(rows.map(r => [r.jurisdiction, r]))

    const result: DpaStatusResult = {
      IN: {
        signed: byJurisdiction.has('IN'),
        signed_at: byJurisdiction.get('IN')?.signed_at ?? null,
        version: byJurisdiction.get('IN')?.version ?? null,
      },
      QA: {
        signed: byJurisdiction.has('QA'),
        signed_at: byJurisdiction.get('QA')?.signed_at ?? null,
        version: byJurisdiction.get('QA')?.version ?? null,
      },
      AE: {
        signed: byJurisdiction.has('AE'),
        signed_at: byJurisdiction.get('AE')?.signed_at ?? null,
        version: byJurisdiction.get('AE')?.version ?? null,
      },
    }

    return reply.send(result)
  })

  // POST /compliance/dpa/sign — record a DPA signing, tenant_id from JWT
  app.post<{ Body: SignDpaBody }>('/compliance/dpa/sign', {
    schema: {
      body: {
        type: 'object',
        required: ['tenant_id', 'jurisdiction', 'signatory_name', 'signatory_email'],
        properties: {
          tenant_id:       { type: 'string' },
          jurisdiction:    { type: 'string', enum: ['IN', 'QA', 'AE'] },
          version:         { type: 'string' },
          signatory_name:  { type: 'string' },
          signatory_email: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    // tenant_id is always taken from the JWT — the body field is ignored to prevent spoofing
    const tenant_id = (req as any).tenantId as string
    const {
      jurisdiction,
      version = '1.0',
      signatory_name,
      signatory_email,
    } = req.body

    // TODO Phase C6: generate a signed PDF, compute pdf_hash, store pdf_path.
    // For now pdf_hash and pdf_path are null — real PDF generation is future work.
    const pdf_hash: string | null = null
    const pdf_path: string | null = null

    const { rows } = await app.pg.query<DpaRecordRow>(
      `INSERT INTO dpa_records
         (tenant_id, jurisdiction, version, signatory_name, signatory_email, pdf_hash, pdf_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, jurisdiction, version) DO UPDATE
         SET signatory_name  = EXCLUDED.signatory_name,
             signatory_email = EXCLUDED.signatory_email,
             signed_at       = NOW(),
             pdf_hash        = EXCLUDED.pdf_hash,
             pdf_path        = EXCLUDED.pdf_path
       RETURNING *`,
      [tenant_id, jurisdiction, version, signatory_name, signatory_email, pdf_hash, pdf_path],
    )

    await writeAuditEvent(app, {
      tenant_id,
      action: 'dpa_signed',
      resource: 'dpa_records',
      resource_id: rows[0].id,
      metadata: { jurisdiction, version, signatory_name, signatory_email },
    })

    return reply.status(201).send({ ...rows[0], pdf_hash: null })
  })

  // GET /compliance/dpa/template/:jurisdiction — return DPA template text (public, no ownership needed)
  app.get<{ Params: { jurisdiction: string } }>('/compliance/dpa/template/:jurisdiction', async (req, reply) => {
    const jurisdiction = req.params.jurisdiction.toUpperCase() as Jurisdiction

    if (!['IN', 'QA', 'AE'].includes(jurisdiction)) {
      return reply.status(400).send({ error: 'unsupported jurisdiction — valid values: IN, QA, AE' })
    }

    return reply.send({
      jurisdiction,
      version: '1.0',
      template: DPA_TEMPLATES[jurisdiction],
      note: 'This is a simplified template. Production DPAs are full legal documents reviewed by counsel.',
    })
  })
}
