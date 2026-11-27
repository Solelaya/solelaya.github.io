/**
 * Cloud Function (Firebase Functions v2) for Automated Account Deletion Requests.
 *
 * Receives verified form submissions from https://solelaya.github.io/account-deletion.html,
 * validates inputs, prevents duplicate pending floods, records the request in Firestore's
 * `deletion_requests` collection (named database), sends an automated email notification
 * to Solelaya Dev support using server-side SMTP environment secrets, and updates the
 * request's notification status in Firestore.
 *
 * Required Firebase Functions secrets/env vars for automated email delivery:
 *   SMTP_HOST, SMTP_PORT (default 465), SMTP_USER, SMTP_PASS, SUPPORT_EMAIL (default solelaya.dev@gmail.com)
 *
 * Deploy via Firebase CLI (`firebase deploy --only functions`) after initializing `functions/`.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();

const DATABASE_ID = "ai-studio-android-flagquiz-bf5fb558-058c-4197-86dc-c3aabb9903f6";
const ALLOWED_ORIGINS = new Set([
  "https://solelaya.github.io",
  "https://www.solelaya.github.io"
]);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_SCOPES = new Set(["full", "partial_history"]);

function sanitizeText(value, maxLen) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function generateReferenceId() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hex = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `DEL-${y}${m}${d}-${hex}`;
}

async function sendSupportNotificationEmail(payload) {
  const smtpHost = (process.env.SMTP_HOST || "").trim();
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").trim();
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const supportEmail = (process.env.SUPPORT_EMAIL || "solelaya.dev@gmail.com").trim();

  if (!smtpHost || !smtpUser || !smtpPass) {
    return { sent: false, status: "EMAIL_PENDING_CONFIG" };
  }

  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch (_) {
    return { sent: false, status: "EMAIL_DEPENDENCY_MISSING" };
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass }
  });

  const scopeLabel = payload.scope === "partial_history"
    ? "Partial Deletion (Quiz & Referral History Only)"
    : "Full Account & All Cloud Data Deletion";

  const textBody = [
    "New Quizly: World Flags Account Deletion Request",
    "===============================================",
    `Reference ID: ${payload.referenceId}`,
    `Status: PENDING (7 business days SLA)`,
    `App Package: com.aistudio.flagquiz.wvxrkm`,
    `Google Account Email: ${payload.email}`,
    `Username / Referral Code: ${payload.username || "Not provided"}`,
    `Deletion Scope: ${scopeLabel}`,
    `Reason Provided: ${payload.reason}`,
    `Submitted At (UTC): ${new Date().toISOString()}`,
    "",
    "Please verify account ownership and update the Firestore document in deletion_requests/" +
      payload.referenceId + " once completed."
  ].join("\n");

  await transporter.sendMail({
    from: `"Quizly Privacy Portal" <${smtpUser}>`,
    to: supportEmail,
    replyTo: payload.email,
    subject: `[Account Deletion ${payload.referenceId}] ${payload.email}`,
    text: textBody
  });

  return { sent: true, status: "SENT" };
}

exports.submitAccountDeletionRequest = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
    timeoutSeconds: 30
  },
  async (req, res) => {
    const origin = req.headers.origin || "";
    if (ALLOWED_ORIGINS.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed. Use POST." });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = sanitizeText(body.email, 160).toLowerCase();
    const username = sanitizeText(body.username, 50);
    const reason = sanitizeText(body.reason, 500);
    const scope = ALLOWED_SCOPES.has(body.scope) ? body.scope : "full";
    const confirmed = body.confirmed === true;

    if (!EMAIL_REGEX.test(email)) {
      res.status(400).json({ ok: false, error: "Please provide a valid Google account email address." });
      return;
    }
    if (reason.length < 5) {
      res.status(400).json({ ok: false, error: "Please briefly explain your reason for requesting account deletion." });
      return;
    }
    if (!confirmed) {
      res.status(400).json({ ok: false, error: "Confirmation checkbox is required." });
      return;
    }

    const db = getFirestore(DATABASE_ID);
    const colRef = db.collection("deletion_requests");

    try {
      // Prevent duplicate pending spam floods for the same email
      const existingPending = await colRef
        .where("email", "==", email)
        .where("status", "==", "PENDING")
        .limit(1)
        .get();

      if (!existingPending.empty) {
        const existingDoc = existingPending.docs[0];
        res.status(200).json({
          ok: true,
          duplicate: true,
          referenceId: existingDoc.id,
          status: "PENDING",
          message: `A pending deletion request (${existingDoc.id}) is already queued for this email.`
        });
        return;
      }

      const referenceId = generateReferenceId();
      const docRef = colRef.doc(referenceId);

      // Optional lookup to link existing Firebase Auth UID if present in /users
      let matchedUserId = "";
      const userSnap = await db.collection("users").where("email", "==", email).limit(1).get();
      if (!userSnap.empty) {
        matchedUserId = userSnap.docs[0].id;
      }

      await docRef.set({
        referenceId,
        userId: matchedUserId,
        email,
        username,
        scope,
        reason,
        status: "PENDING",
        notificationStatus: "QUEUED",
        source: "web_form",
        packageId: "com.aistudio.flagquiz.wvxrkm",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      let emailOutcome = { sent: false, status: "EMAIL_FAILED" };
      try {
        emailOutcome = await sendSupportNotificationEmail({
          referenceId,
          email,
          username,
          scope,
          reason
        });
      } catch (mailErr) {
        console.error("Support notification email error:", mailErr);
      }

      await docRef.update({
        notificationStatus: emailOutcome.status,
        updatedAt: FieldValue.serverTimestamp()
      });

      res.status(201).json({
        ok: true,
        referenceId,
        status: "PENDING",
        notificationStatus: emailOutcome.status,
        message: emailOutcome.sent
          ? `Deletion request ${referenceId} recorded (Status: PENDING) and support team notified.`
          : `Deletion request ${referenceId} recorded in Firestore (Status: PENDING) for support review within 7 business days.`
      });
    } catch (err) {
      console.error("Account deletion request error:", err);
      res.status(500).json({
        ok: false,
        error: "Unable to process deletion request right now. Please try again or email solelaya.dev@gmail.com."
      });
    }
  }
);
