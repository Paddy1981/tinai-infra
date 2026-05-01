import { NextRequest, NextResponse } from "next/server";
import { getTokenFromCookies, getUserFromToken } from "@/lib/auth";
import { getSession, jmapRequest } from "@/lib/jmap";

export async function GET(request: NextRequest) {
  try {
    const token = await getTokenFromCookies();
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getUserFromToken(token);
    if (!user) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const mailboxId = searchParams.get("mailboxId");
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const position = parseInt(searchParams.get("position") || "0", 10);

    if (!mailboxId) {
      return NextResponse.json(
        { error: "mailboxId is required" },
        { status: 400 }
      );
    }

    const session = await getSession(user.email);
    const accountId = Object.keys(session.accounts)[0];

    const result = await jmapRequest(user.email, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/query",
          {
            accountId,
            filter: { inMailbox: mailboxId },
            sort: [{ property: "receivedAt", isAscending: false }],
            position,
            limit,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": {
              resultOf: "q",
              name: "Email/query",
              path: "/ids",
            },
            properties: [
              "id",
              "blobId",
              "threadId",
              "mailboxIds",
              "from",
              "to",
              "cc",
              "subject",
              "receivedAt",
              "preview",
              "keywords",
              "hasAttachment",
              "size",
            ],
          },
          "g",
        ],
      ],
    });

    const queryResult = result.methodResponses[0][1];
    const emails = result.methodResponses[1][1].list;

    return NextResponse.json({
      accountId,
      total: queryResult.total,
      emails,
    });
  } catch (err: any) {
    console.error("Emails error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to get emails" },
      { status: 500 }
    );
  }
}
