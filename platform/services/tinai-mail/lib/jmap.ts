const JMAP_URL =
  process.env.JMAP_URL || "http://stalwart.core.svc.cluster.local:8080";
const STALWART_PASSWORD = process.env.STALWART_PASSWORD || "Padma06@88723332";

export function toMailAccount(email: string): string {
  const local = email.split("@")[0];
  return `${local}@tinai.cloud`;
}

function basicAuth(email: string): string {
  const mailAccount = toMailAccount(email);
  return Buffer.from(`${mailAccount}:${STALWART_PASSWORD}`).toString("base64");
}

export async function jmapRequest(email: string, body: object): Promise<any> {
  const res = await fetch(`${JMAP_URL}/jmap/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth(email)}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JMAP error ${res.status}: ${text}`);
  }

  return res.json();
}

export async function getSession(email: string): Promise<any> {
  const res = await fetch(`${JMAP_URL}/jmap/session`, {
    headers: {
      Authorization: `Basic ${basicAuth(email)}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JMAP session error ${res.status}: ${text}`);
  }

  return res.json();
}

export async function jmapSubmission(
  email: string,
  body: object
): Promise<any> {
  const res = await fetch(`${JMAP_URL}/jmap/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth(email)}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JMAP submission error ${res.status}: ${text}`);
  }

  return res.json();
}
