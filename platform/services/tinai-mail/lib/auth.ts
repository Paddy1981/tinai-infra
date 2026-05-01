import { jwtVerify } from "jose";
import { cookies } from "next/headers";

export const COOKIE_NAME = "tinai_mail_token";

const JWT_SECRET = process.env.JWT_SECRET || "tinai-secret-change-me";
const TINAI_AUTH_URL =
  process.env.TINAI_AUTH_URL || "http://tinai-auth.core.svc.cluster.local:3000";

export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
  tenant_id: string;
}

export async function getUserFromToken(
  token: string
): Promise<TokenPayload | null> {
  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    return {
      sub: payload.sub as string,
      email: (payload.email as string) || (payload.sub as string),
      role: (payload.role as string) || "user",
      tenant_id: (payload.tenant_id as string) || "",
    };
  } catch {
    return null;
  }
}

export async function getTokenFromCookies(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(COOKIE_NAME)?.value;
}

export function getAuthUrl(): string {
  return TINAI_AUTH_URL;
}
