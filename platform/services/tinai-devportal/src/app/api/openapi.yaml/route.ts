import { readFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

// Serve the bundled OpenAPI spec — merges agri + bhashini into one document
export function GET() {
  try {
    const agri = readFileSync(
      join(process.cwd(), "public", "openapi", "tinai-agri.openapi.yaml"),
      "utf-8"
    );
    return new NextResponse(agri, {
      headers: {
        "Content-Type": "application/yaml",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    console.error("[openapi] failed to serve spec:", err);
    return NextResponse.json({ error: "spec not found" }, { status: 404 });
  }
}
