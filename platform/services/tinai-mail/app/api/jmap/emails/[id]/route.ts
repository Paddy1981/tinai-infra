import { NextRequest, NextResponse } from "next/server";
import { getTokenFromCookies, getUserFromToken } from "@/lib/auth";
import { getSession, jmapRequest } from "@/lib/jmap";

type RouteCtx = { params: Promise<{ id: string }> };

async function getAuth() {
  const token = await getTokenFromCookies();
  if (!token) return null;
  const user = await getUserFromToken(token);
  if (!user) return null;
  return user;
}

export async function GET(request: NextRequest, { params }: RouteCtx) {
  try {
    const user = await getAuth();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const session = await getSession(user.email);
    const accountId = Object.keys(session.accounts)[0];

    const result = await jmapRequest(user.email, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Email/get", {
          accountId,
          ids: [id],
          properties: [
            "id", "blobId", "threadId", "mailboxIds", "from", "to", "cc", "bcc",
            "replyTo", "subject", "sentAt", "receivedAt", "preview", "keywords",
            "hasAttachment", "size", "bodyValues", "htmlBody", "textBody", "attachments",
          ],
          fetchHTMLBodyValues: true,
          fetchTextBodyValues: true,
        }, "0"],
      ],
    });

    const email = result.methodResponses[0][1].list[0];
    if (!email) return NextResponse.json({ error: "Email not found" }, { status: 404 });

    // Mark as read if unread
    if (!email.keywords?.["$seen"]) {
      await jmapRequest(user.email, {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
          ["Email/set", { accountId, update: { [id]: { "keywords/$seen": true } } }, "m"],
        ],
      });
    }

    return NextResponse.json({ accountId, email });
  } catch (err: any) {
    console.error("Email detail error:", err);
    return NextResponse.json({ error: err.message || "Failed to get email" }, { status: 500 });
  }
}

/** DELETE — move to trash or permanently destroy */
export async function DELETE(request: NextRequest, { params }: RouteCtx) {
  try {
    const user = await getAuth();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const permanent = body.permanent === true;

    const session = await getSession(user.email);
    const accountId = Object.keys(session.accounts)[0];

    if (permanent) {
      const result = await jmapRequest(user.email, {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Email/set", { accountId, destroy: [id] }, "0"]],
      });
      const setResult = result.methodResponses[0][1];
      if (setResult.notDestroyed) {
        const err = Object.values(setResult.notDestroyed)[0] as any;
        return NextResponse.json({ error: err?.description ?? "Delete failed" }, { status: 400 });
      }
      return NextResponse.json({ ok: true, action: "destroyed" });
    }

    // Find Trash mailbox
    const mbResult = await jmapRequest(user.email, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [["Mailbox/get", { accountId }, "0"]],
    });
    const mailboxes = mbResult.methodResponses[0][1].list;
    const trash = mailboxes.find((m: any) => m.role === "trash");
    if (!trash) return NextResponse.json({ error: "Trash not found" }, { status: 500 });

    const result = await jmapRequest(user.email, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [["Email/set", {
        accountId,
        update: { [id]: { mailboxIds: { [trash.id]: true } } },
      }, "0"]],
    });
    const setResult = result.methodResponses[0][1];
    if (setResult.notUpdated) {
      const err = Object.values(setResult.notUpdated)[0] as any;
      return NextResponse.json({ error: err?.description ?? "Trash failed" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, action: "trashed" });
  } catch (err: any) {
    console.error("Delete error:", err);
    return NextResponse.json({ error: err.message || "Failed" }, { status: 500 });
  }
}

/** PUT — update keywords or mailbox */
export async function PUT(request: NextRequest, { params }: RouteCtx) {
  try {
    const user = await getAuth();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = await request.json();

    const session = await getSession(user.email);
    const accountId = Object.keys(session.accounts)[0];

    const update: Record<string, unknown> = {};
    if (body.keywords !== undefined) update.keywords = body.keywords;
    if (body.mailboxIds !== undefined) update.mailboxIds = body.mailboxIds;

    if (!Object.keys(update).length) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const result = await jmapRequest(user.email, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [["Email/set", { accountId, update: { [id]: update } }, "0"]],
    });
    const setResult = result.methodResponses[0][1];
    if (setResult.notUpdated) {
      const err = Object.values(setResult.notUpdated)[0] as any;
      return NextResponse.json({ error: err?.description ?? "Update failed" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Update error:", err);
    return NextResponse.json({ error: err.message || "Failed" }, { status: 500 });
  }
}
