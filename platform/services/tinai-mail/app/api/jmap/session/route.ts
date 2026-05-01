import { NextResponse } from "next/server";
import { getTokenFromCookies, getUserFromToken } from "@/lib/auth";
import { getSession } from "@/lib/jmap";

export async function GET() {
  try {
    const token = await getTokenFromCookies();
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getUserFromToken(token);
    if (!user) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const session = await getSession(user.email);
    return NextResponse.json(session);
  } catch (err: any) {
    console.error("JMAP session error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to get session" },
      { status: 500 }
    );
  }
}
