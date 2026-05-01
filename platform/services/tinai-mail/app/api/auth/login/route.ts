import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, getAuthUrl } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    const authUrl = getAuthUrl();
    const res = await fetch(`${authUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const text = await res.text();
      let errorMsg = "Authentication failed";
      try {
        const errData = JSON.parse(text);
        errorMsg = errData.error || errData.message || errorMsg;
      } catch {}
      return NextResponse.json({ error: errorMsg }, { status: res.status });
    }

    const data = await res.json();
    const token = data.token || data.access_token;

    if (!token) {
      return NextResponse.json(
        { error: "No token received from auth service" },
        { status: 500 }
      );
    }

    const response = NextResponse.json({
      ok: true,
      user: { email: data.email || email },
    });

    response.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return response;
  } catch (err: any) {
    console.error("Login error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
