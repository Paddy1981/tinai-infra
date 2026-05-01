import { NextRequest, NextResponse } from "next/server";
import { getTokenFromCookies, getUserFromToken } from "@/lib/auth";
import { getSession, jmapRequest, toMailAccount } from "@/lib/jmap";

export async function POST(request: NextRequest) {
  try {
    const token = await getTokenFromCookies();
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getUserFromToken(token);
    if (!user) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const { to, cc, bcc, subject, body, inReplyTo, references } =
      await request.json();

    if (!to || !to.length) {
      return NextResponse.json(
        { error: "At least one recipient is required" },
        { status: 400 }
      );
    }

    const session = await getSession(user.email);
    const accountId = Object.keys(session.accounts)[0];
    const fromAddress = toMailAccount(user.email);

    // Step 1: Get identity and mailboxes (drafts + sent)
    const setupResult = await jmapRequest(user.email, {
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
      ],
      methodCalls: [
        [
          "Identity/get",
          { accountId },
          "i",
        ],
        [
          "Mailbox/get",
          { accountId },
          "m",
        ],
      ],
    });

    const identities = setupResult.methodResponses[0][1].list;
    if (!identities || identities.length === 0) {
      return NextResponse.json(
        { error: "No email identity found for this account" },
        { status: 500 }
      );
    }
    const identityId = identities[0].id;

    const mailboxes = setupResult.methodResponses[1][1].list;
    const draftsMailbox = mailboxes.find(
      (m: any) => m.role === "drafts"
    );
    const sentMailbox = mailboxes.find(
      (m: any) => m.role === "sent"
    );

    if (!draftsMailbox || !sentMailbox) {
      return NextResponse.json(
        { error: "Could not find Drafts or Sent mailbox" },
        { status: 500 }
      );
    }

    // Step 2: Create email in Drafts, submit with identityId,
    // and on success move from Drafts to Sent
    const emailCreate: any = {
      mailboxIds: { [draftsMailbox.id]: true },
      from: [{ email: fromAddress }],
      to: to.map((addr: string) => ({ email: addr.trim() })),
      subject: subject || "(No subject)",
      bodyValues: {
        body: {
          value: body || "",
          charset: "utf-8",
        },
      },
      textBody: [{ partId: "body", type: "text/plain" }],
      keywords: { $seen: true, $draft: true },
    };

    if (cc?.length) {
      emailCreate.cc = cc.map((addr: string) => ({ email: addr.trim() }));
    }
    if (bcc?.length) {
      emailCreate.bcc = bcc.map((addr: string) => ({ email: addr.trim() }));
    }
    if (inReplyTo) {
      emailCreate.inReplyTo = [inReplyTo];
    }
    if (references?.length) {
      emailCreate.references = references;
    }

    const result = await jmapRequest(user.email, {
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
      ],
      methodCalls: [
        [
          "Email/set",
          {
            accountId,
            create: {
              draft: emailCreate,
            },
          },
          "c",
        ],
        [
          "EmailSubmission/set",
          {
            accountId,
            create: {
              send: {
                identityId,
                emailId: "#draft",
                envelope: {
                  mailFrom: { email: fromAddress },
                  rcptTo: [
                    ...to.map((addr: string) => ({ email: addr.trim() })),
                    ...(cc || []).map((addr: string) => ({
                      email: addr.trim(),
                    })),
                    ...(bcc || []).map((addr: string) => ({
                      email: addr.trim(),
                    })),
                  ],
                },
              },
            },
            onSuccessUpdateEmail: {
              "#send": {
                [`mailboxIds/${draftsMailbox.id}`]: null,
                [`mailboxIds/${sentMailbox.id}`]: true,
                "keywords/$draft": null,
              },
            },
          },
          "s",
        ],
      ],
    });

    const createResult = result.methodResponses[0][1];
    const submitResult = result.methodResponses[1][1];

    if (createResult.notCreated) {
      return NextResponse.json(
        { error: "Failed to create email", details: createResult.notCreated },
        { status: 500 }
      );
    }

    if (submitResult.notCreated) {
      return NextResponse.json(
        { error: "Failed to send email", details: submitResult.notCreated },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Send error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to send email" },
      { status: 500 }
    );
  }
}
