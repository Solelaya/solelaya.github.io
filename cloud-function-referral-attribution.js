/**
 * Cloud Function (Firebase Functions v2) for automatic server-side referral attribution.
 *
 * When a newly signed-in player links an inviter's referral code (`invitedByCode`) on their
 * `/users/{inviteeUid}` profile document, this function securely looks up the inviter by
 * `referralCode` and writes a verified Pending referral document into
 * `/users/{inviterUid}/referrals/{inviteeUid}` — keeping cross-user writes strictly server-side.
 *
 * Deploy with Firebase CLI (`firebase deploy --only functions`) after initializing `functions/`.
 */
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();

const DATABASE_ID = "ai-studio-android-flagquiz-bf5fb558-058c-4197-86dc-c3aabb9903f6";

exports.attributeLinkedReferral = onDocumentUpdated(
  {
    document: "users/{inviteeUid}",
    database: DATABASE_ID
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;

    const prevCode = (before.invitedByCode || "").trim().toUpperCase();
    const nextCode = (after.invitedByCode || "").trim().toUpperCase();
    if (!nextCode || prevCode === nextCode) return;

    const inviteeUid = event.params.inviteeUid;
    const db = getFirestore(DATABASE_ID);

    const inviterQuery = await db
      .collection("users")
      .where("referralCode", "==", nextCode)
      .limit(1)
      .get();

    if (inviterQuery.empty) return;
    const inviterDoc = inviterQuery.docs[0];
    if (inviterDoc.id === inviteeUid) return; // Block self-referrals server-side

    const referralRef = db
      .collection("users")
      .doc(inviterDoc.id)
      .collection("referrals")
      .doc(inviteeUid);

    await db.runTransaction(async (tx) => {
      const existing = await tx.get(referralRef);
      if (existing.exists) return;

      const heartsUsed = Math.max(0, Number(after.totalHeartsUsed || 0));
      const todayIso = new Date().toISOString().slice(0, 10);

      tx.set(referralRef, {
        username: String(after.username || "Player").slice(0, 40),
        avatarEmoji: String(after.avatarIcon || "🌍").slice(0, 16),
        countryFlag: String(after.countryFlag || "🌍").slice(0, 16),
        countryName: String(after.countryName || "Global").slice(0, 60),
        totalCoinsEarned: Math.max(0, Number(after.totalCoinsEarned || 0)),
        commissionPaidCoins: 0,
        pendingCommissionCoins: 0,
        pendingCommissionDate: "",
        joinedDate: todayIso,
        heartsUsed,
        dailyHeartsUsed: Math.max(0, Number(after.heartsUsedToday || 0)),
        lastHeartUsageDate: String(after.lastHeartUsageDate || todayIso).slice(0, 32),
        isCurrentlyActive: heartsUsed >= 5,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    });
  }
);
