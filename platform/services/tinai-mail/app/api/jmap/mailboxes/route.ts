import { NextResponse } from "next/server";
import { getTokenFromCookies, getUserFromToken } from "@/lib/auth";
import { getSession, jmapRequest } from "@/lib/jmap";

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
    const accountId = Object.keys(session.accounts)[0];

    const result = await jmapRequest(user.email, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Mailbox/get",
          {
            accountId,
            properties: [
              "id",
              "name",
              "role",
              "totalEmails",
              "unreadEmails",
              "sortOrder",
              "parentId",
            ],
          },
          "0",
        ],
      ],
    });

    const mailboxes = result.methodResponses[0][1].list;
    return NextResponse.json({ accountId, mailboxes });
  } catch (err: any) {
    console.error("Mailboxes error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to get mailboxes" },
      { status: 500 }
    );
  }
}
