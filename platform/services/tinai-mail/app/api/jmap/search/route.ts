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
    const q = searchParams.get("q");
    const mailboxId = searchParams.get("mailboxId");
    const limit = parseInt(searchParams.get("limit") || "50", 10);

    if (!q) {
      return NextResponse.json(
        { error: "q (search query) is required" },
        { status: 400 }
      );
    }

    const session = await getSession(user.email);
    const accountId = Object.keys(session.accounts)[0];

    const filter: any = { text: q };
    if (mailboxId) {
      filter.inMailbox = mailboxId;
    }

    const result = await jmapRequest(user.email, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/query",
          {
            accountId,
            filter,
            sort: [{ property: "receivedAt", isAscending: false }],
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
      total: queryResult.total,
      emails,
    });
  } catch (err: any) {
    console.error("Search error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to search emails" },
      { status: 500 }
    );
  }
}
