// invoice-generator/src/lago-client.js
// Lago REST API client for the invoice generator.

import { config } from '../../shared/config.js';

async function lagoGet(path, logger) {
  const res = await fetch(`${config.lago.url}/api/v1${path}`, {
    headers: {
      Authorization: `Bearer ${config.lago.apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Lago GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchInvoiceFromLago(invoiceId, logger) {
  const data = await lagoGet(`/invoices/${invoiceId}`, logger);
  return data.invoice ?? data;
}

export async function fetchCustomerFromLago(externalId, logger) {
  const data = await lagoGet(`/customers/${externalId}`, logger);
  return data.customer ?? data;
}
