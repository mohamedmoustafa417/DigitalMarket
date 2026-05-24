/**
 * DigitalMarket – Cloud Functions (Node 20)
 *
 * Deploy:  firebase deploy --only functions
 * Emulate: firebase emulators:start --only functions,firestore,storage
 *
 * Current functions
 * ─────────────────
 *  1. onOrderStatusChange  – Firestore trigger: orders/{orderId}
 *     • When status changes → 'approved', sends the buyer an email with
 *       their download links and records the event to GA4 Measurement Protocol.
 *     • When status changes → 'refunded', notifies buyer and updates seller balance.
 *
 *  2. cleanExpiredDownloads – Scheduled (daily 00:00 UTC)
 *     • Sets `downloadExpired: true` on orders whose downloadExpiresAt < now.
 *
 *  3. onProductFileDelete – Storage trigger: products/{sellerId}/{filename}
 *     • When a seller deletes their account, cascades deletion of their
 *       uploaded product files from Storage.
 *
 *  4. onNewReview – Firestore trigger: reviews/{reviewId}
 *     • Recalculates the product's ratingAvg + ratingCount and writes it
 *       back to products/{productId} atomically.
 *
 *  5. generateSitemap – HTTPS callable
 *     • Returns a fresh sitemap XML string with all approved product slugs.
 *     • Called by a GitHub Actions cron to regenerate sitemap.xml weekly.
 */

'use strict';

const { onDocumentWritten, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { onObjectDeleted, onObjectFinalized } = require('firebase-functions/v2/storage');
const { onSchedule }             = require('firebase-functions/v2/scheduler');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }           = require('firebase-functions/params');
const { initializeApp }          = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage }             = require('firebase-admin/storage');

initializeApp();
const db      = getFirestore();
const storage = getStorage();

// Secret bindings — set via:  firebase functions:secrets:set RESEND_KEY
// (SENDGRID_KEY also supported by sendEmail() via process.env; add to this list
//  AND set the secret in Firebase if you ever want to use SendGrid as fallback)
const RESEND_KEY   = defineSecret('RESEND_KEY');
const EMAIL_SECRETS = [RESEND_KEY];

// Optional: Google Drive service-account JSON for per-buyer file sharing.
// When set, the downloadFile CF will grant the buyer's email reader access
// to the Drive file at download time and the daily
// `revokeExpiredDriveGrants` scheduler will revoke after 30 days.
// To enable: `firebase functions:secrets:set GDRIVE_SA_JSON` (paste the
// raw JSON contents of the service-account key). The service account also
// needs reader access on each Drive file/folder a seller uploads to — the
// easiest is to share each file with the service-account email manually,
// or use a shared Drive that the service account owns.
const GDRIVE_SA_JSON = defineSecret('GDRIVE_SA_JSON');
const DRIVE_SECRETS  = [GDRIVE_SA_JSON];

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Transactional email sender — picks the first configured provider.
 *
 * To activate ONE-TIME from your terminal:
 *   firebase functions:secrets:set RESEND_KEY      # Recommended (3K/mo free)
 *   firebase functions:secrets:set SENDGRID_KEY    # OR this (100/day free)
 *   firebase deploy --only functions
 *
 * Until a key is set, sendEmail() logs to console (won't crash the function
 * caller, so the broader order/KYC flow keeps working).
 */
// FROM uses support@ (not noreply@) — when buyers click Reply, mail goes
// straight to the PrivateEmail inbox we already have. Higher trust + simpler.
const FROM_EMAIL = 'support@digitalmarketstore.shop';
const FROM_NAME  = 'DigitalMarket';
const REPLY_TO   = 'support@digitalmarketstore.shop';

/** Short non-reversible hash of an email for logging (GDPR — don't put raw
 *  buyer email in Cloud Logging where it persists for 30+ days). */
function hashEmail(e) {
  if (!e || typeof e !== 'string') return '';
  return require('crypto').createHash('sha256').update(e.toLowerCase().trim()).digest('hex').slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════
// GOOGLE DRIVE — per-buyer file sharing
//
// When the seller's downloadUrl is a Google Drive link AND the GDRIVE_SA_JSON
// secret is configured, the downloadFile CF (instead of returning the public
// link) uses the Drive API to:
//   1. Extract the file ID from the URL
//   2. Grant the buyer's email reader access (sendNotificationEmail:false)
//   3. Record the grant in /driveGrants/{permissionId}
//   4. Return the file's webContentLink (direct download URL)
// A daily scheduled function revokes grants older than 30 days.
//
// Setup: see README — needs (a) a GCP service account JSON, (b) Drive API
// enabled, (c) the service account's email shared on each Drive file/folder
// the marketplace will sell.
// ═══════════════════════════════════════════════════════════════════

let _driveClient = null;
function getDriveClient() {
  if (_driveClient) return _driveClient;
  const raw = process.env.GDRIVE_SA_JSON;
  if (!raw || raw === '{}' || raw === 'null') return null;
  try {
    const creds = JSON.parse(raw);
    // Real credentials have both fields; placeholder {} or partial JSON
    // would crash the JWT auth later — refuse to build the client and
    // let the caller fall back to the public-URL path.
    if (!creds || !creds.client_email || !creds.private_key) return null;
    const { google } = require('googleapis');
    const auth = new google.auth.JWT({
      email:  creds.client_email,
      key:    creds.private_key,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    _driveClient = google.drive({ version: 'v3', auth });
    return _driveClient;
  } catch (e) {
    console.error('[drive] failed to init client:', e.message);
    return null;
  }
}

/** Extract a Drive file ID from common share-URL shapes. */
function extractDriveFileId(url) {
  if (!url) return null;
  // /file/d/{id}/view, /file/d/{id}/edit, /file/d/{id}
  let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  // /open?id={id}  and /uc?id={id}
  m = url.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  // /folders/{id}
  m = url.match(/\/folders\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return null;
}

/** Grant `email` reader access to the Drive file. Returns the permission ID
 *  on success so we can revoke later, or null on failure. */
async function grantDriveAccess(fileId, email) {
  const drive = getDriveClient();
  if (!drive || !fileId || !email) return null;
  try {
    const r = await drive.permissions.create({
      fileId,
      requestBody: {
        type: 'user',
        role: 'reader',
        emailAddress: email
      },
      sendNotificationEmail: false,
      supportsAllDrives: true
    });
    return r.data?.id || null;
  } catch (e) {
    console.warn(`[drive] grant failed for ${fileId}:`, e.message);
    return null;
  }
}

/** Revoke a previously-issued Drive permission. */
async function revokeDriveAccess(fileId, permissionId) {
  const drive = getDriveClient();
  if (!drive || !fileId || !permissionId) return false;
  try {
    await drive.permissions.delete({
      fileId,
      permissionId,
      supportsAllDrives: true
    });
    return true;
  } catch (e) {
    // 404 = already gone (file deleted or permission revoked elsewhere)
    if (!/404|not found/i.test(String(e.message || ''))) {
      console.warn(`[drive] revoke failed for ${fileId}/${permissionId}:`, e.message);
    }
    return false;
  }
}

async function sendEmail({ to, subject, body }) {
  const resendKey   = process.env.RESEND_KEY;
  const sendgridKey = process.env.SENDGRID_KEY;

  if (!resendKey && !sendgridKey) {
    console.warn(`[sendEmail] No email provider configured — skipping email to ${to}. Set RESEND_KEY or SENDGRID_KEY.`);
    return { ok: false, reason: 'no-provider' };
  }

  try {
    // Resend (preferred — clean modern API)
    if (resendKey) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          to: [to],
          reply_to: REPLY_TO,
          subject,
          html: body
        })
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error(`[sendEmail] Resend HTTP ${r.status}: ${errText.slice(0, 200)}`);
        return { ok: false, reason: 'resend-failed', status: r.status };
      }
      console.log(`[sendEmail] ✓ Resend sent to ${hashEmail(to)}: "${subject.slice(0, 40)}"`);
      return { ok: true, provider: 'resend' };
    }

    // SendGrid fallback
    if (sendgridKey) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sendgridKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }], subject }],
          from: { email: FROM_EMAIL, name: FROM_NAME },
          reply_to: { email: REPLY_TO },
          content: [{ type: 'text/html', value: body }]
        })
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error(`[sendEmail] SendGrid HTTP ${r.status}: ${errText.slice(0, 200)}`);
        return { ok: false, reason: 'sendgrid-failed', status: r.status };
      }
      console.log(`[sendEmail] ✓ SendGrid sent to ${to}: "${subject.slice(0, 40)}"`);
      return { ok: true, provider: 'sendgrid' };
    }
  } catch (e) {
    console.error(`[sendEmail] Threw for ${to}:`, e.message);
    return { ok: false, reason: 'exception', error: e.message };
  }
}

// ─── 1. onOrderStatusChange ────────────────────────────────────────────────

exports.onOrderStatusChange = onDocumentWritten(
  { document: 'orders/{orderId}', region: 'us-central1', secrets: EMAIL_SECRETS },
  async event => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    const orderId = event.params.orderId;

    if (!after) return; // deletion event — nothing to do

    // ── Order CREATED → confirm to buyer + notify admin ─────────────────
    // (Replaces the legacy EmailJS pipeline. CF is now the single source
    // of truth for transactional email; client-side EmailJS calls were
    // disabled to stop duplicate sends.)
    if (!before && after.status === 'pending') {
      const buyerEmail = after.buyerEmail || '';
      const buyerName  = after.buyerName  || 'Valued Customer';
      const total      = Number(after.total || 0);
      const items      = (after.items || []).map(i => i.name).join(', ');
      const refNum     = after.referenceNum || '';
      const payMethod  = after.paymentMethod || '';
      const orderShort = orderId.slice(0,8).toUpperCase();

      // Buyer confirmation
      if (buyerEmail) {
        try {
          await sendEmail({
            to: buyerEmail,
            subject: `📥 Order received #${orderShort} — DigitalMarket`,
            body: `<p>Hi ${buyerName},</p>
                   <p>We have received your order <strong>#${orderShort}</strong> and your payment proof is being reviewed. You will get another email with your download links once approved (usually within 24 hours).</p>
                   <p><strong>Items:</strong> ${items}<br>
                      <strong>Total:</strong> EGP ${total}<br>
                      <strong>Payment:</strong> ${payMethod}${refNum ? ` — Ref: ${refNum}` : ''}</p>
                   <p>Reply to this email if you have any questions.</p>
                   <p>— The DigitalMarket Team</p>`
          });
        } catch (e) {
          console.warn(`[onOrderStatusChange:created] buyer email failed for ${orderId}:`, e.message);
        }
      }

      // Admin notification — single fixed admin recipient.
      try {
        await sendEmail({
          to: 'mohamed.moustafa417@gmail.com',
          subject: `[Admin] New order EGP ${total} — #${orderShort}`,
          body: `<p>New order received.</p>
                 <p><strong>Buyer:</strong> ${buyerName} (${buyerEmail})<br>
                    <strong>Order ID:</strong> ${orderId}<br>
                    <strong>Items:</strong> ${items}<br>
                    <strong>Total:</strong> EGP ${total}<br>
                    <strong>Payment:</strong> ${payMethod} — Ref: ${refNum}</p>
                 <p><a href="https://digitalmarketstore.shop/#admin-orders">Open admin orders →</a></p>`
        });
      } catch (e) {
        console.warn(`[onOrderStatusChange:created] admin email failed for ${orderId}:`, e.message);
      }
      return; // creation flow done — don't fall through to status-change logic
    }

    if (!before) return;                             // other create events (no email)
    if (before.status === after.status) return;      // no status change

    // ── Order approved → issue download token + license keys + send email ──
    if (after.status === 'approved') {
      // IDEMPOTENCY: if this order was already processed (admin toggled
      // pending→approved→pending→approved), don't re-issue tokens, don't
      // re-bump seller tier, don't re-award loyalty points. The line 143
      // guard only catches no-status-change events, not pending⇄approved cycles.
      if (after.approvalProcessedAt && after.downloadToken) {
        console.log(`[onOrderStatusChange] order ${orderId} already processed at ${after.approvalProcessedAt?.toDate?.()}; skipping re-issue.`);
        return;
      }

      // Issue a secure download token (30-day expiry)
      const token     = require('crypto').randomUUID();
      const expiresAt = Date.now() + 30 * 86400000;

      // Issue license keys for each item (if seller has licenseEnabled).
      // Use crypto.randomBytes (not Math.random) for license-quality entropy.
      const crypto = require('crypto');
      const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // dropped 0/O/1/I for legibility
      const seg    = () => {
        const buf = crypto.randomBytes(4);
        return Array.from(buf).map(b => chars[b % chars.length]).join('');
      };
      const genKey = () => `${seg()}-${seg()}-${seg()}-${seg()}`;
      const licenseKeys = {};
      (after.items || []).forEach(item => { licenseKeys[item.id] = genKey(); });

      // BATCH ALL ORDER WRITES into one update so the function self-triggers
      // exactly once (and that re-trigger returns at the line 143 guard).
      await event.data.after.ref.update({
        downloadToken: token,
        downloadExpiresAt: expiresAt,
        downloadExpired: false,
        licenseKeys,
        approvalProcessedAt: FieldValue.serverTimestamp()
      });

      // SELLER TIER — fix read-modify-write race. Two concurrent approvals
      // were both reading the same `totalSales`, computing the same tier,
      // and missing the boundary promotion (199→200 stuck at Gold). Wrap
      // in a transaction so the read+compute+write serializes.
      const TIERS = [[200,'Platinum'],[50,'Gold'],[10,'Silver'],[0,'Bronze']];
      for (const sid of (after.sellerIds || [])) {
        try {
          const sellerRef = db.collection('users').doc(sid);
          await db.runTransaction(async tx => {
            const snap     = await tx.get(sellerRef);
            const newCount = (snap.data()?.totalSales || 0) + 1;
            const tier     = (TIERS.find(([min]) => newCount >= min) || TIERS[3])[1];
            tx.update(sellerRef, { totalSales: newCount, tier });
          });
        } catch (e) {
          console.warn(`[onOrderStatusChange] seller tier update failed for ${sid}:`, e.message);
        }
      }

      // Loyalty: settle BOTH the redeem (if any) and the new earn in ONE
      // transaction. The order doc carries `pointsRedeemed` from the buyer's
      // submission; we verify the balance before deducting so two parallel
      // checkouts cannot double-spend. The earn (loyaltyPoints += total) is
      // computed against the same starting balance.
      if (after.buyerId) {
        const buyerRef    = db.collection('users').doc(after.buyerId);
        const ptsRedeemed = Math.max(0, Math.floor(Number(after.pointsRedeemed || 0)));
        // CORRECTNESS: earn on the SUBTOTAL (the full value of products
        // purchased), not on `total` (which has loyalty redeem already
        // subtracted). This prevents the death-spiral where redeeming
        // points reduces future earn. Math.round handles the 99.50 case
        // cleanly (previous Math.floor silently dropped 0.5 → 99 pts).
        const earnBase    = Number(after.subtotal != null ? after.subtotal : after.total) || 0;
        const ptsEarned   = Math.max(0, Math.round(earnBase));
        if (ptsRedeemed > 0 || ptsEarned > 0) {
          try {
            await db.runTransaction(async tx => {
              const snap        = await tx.get(buyerRef);
              const currentBal  = Number(snap.data()?.loyaltyPoints || 0);
              // Deduct only as much as the buyer actually has — never let
              // a buyer go negative even if the order claimed more than balance.
              const effectiveRedeem = Math.min(ptsRedeemed, currentBal);
              const newBal          = currentBal - effectiveRedeem + ptsEarned;
              tx.update(buyerRef, { loyaltyPoints: newBal });
              if (effectiveRedeem > 0) {
                const logRef = buyerRef.collection('pointsLog').doc();
                tx.set(logRef, {
                  type: 'redeem', pts: -effectiveRedeem,
                  reason: `Redeemed on order ${orderId.slice(0,8).toUpperCase()}`,
                  orderId,
                  createdAt: FieldValue.serverTimestamp()
                });
              }
              if (ptsEarned > 0) {
                const logRef = buyerRef.collection('pointsLog').doc();
                tx.set(logRef, {
                  type: 'earn', pts: ptsEarned,
                  reason: `Purchase EGP ${after.total}`,
                  orderId,
                  createdAt: FieldValue.serverTimestamp()
                });
              }
            });
          } catch (e) {
            console.warn(`[onOrderStatusChange] loyalty settlement failed for order ${orderId}:`, e.message);
          }
        }
      }

      const items      = after.items || [];
      const buyerEmail = after.buyerEmail || '';
      const buyerName  = after.buyerName  || 'Valued Customer';
      const orderShort = orderId.slice(0,8).toUpperCase();
      const ordersUrl  = 'https://digitalmarketstore.shop/#orders';

      // SECURITY: the email used to embed raw product.downloadUrl values
      // — defeating the auth + per-buyer Drive sharing + 30-day expiry
      // gates we built into the downloadFile CF. ANYONE the buyer
      // forwarded the email to could hit those raw links.
      // Now we send a single CTA pointing buyers to /orders, where the
      // Download button routes through secureDownload → CF →
      // per-buyer Drive grant → audit log. Plus we list what they
      // bought as plain text so the email is still useful.
      const itemList = items.map(i => `<li>${(i.name || 'Product')}</li>`).join('');

      // RELIABILITY: wrap the post-idempotency side effects in try/catch.
      // Previously: if sendEmail threw (Resend 5xx, transient network),
      // the function retried, the idempotency guard short-circuited at
      // the top, and the buyer email was permanently lost. Now: log the
      // failure to /emailFailures so an admin can re-send manually, and
      // let the order finish in a clean state.
      if (buyerEmail) {
        try {
          const result = await sendEmail({
            to:      buyerEmail,
            subject: '✅ Your DigitalMarket order is ready!',
            body:    `<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;color:#1a1a2e;">
                     <h2 style="color:#6366f1;margin-bottom:0.5rem;">Your order is ready to download</h2>
                     <p>Hi ${buyerName},</p>
                     <p>Your order <strong>#${orderShort}</strong> has been approved. You can download your files from the My Orders page.</p>
                     <p style="margin:20px 0;">
                       <a href="${ordersUrl}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;">📥 Open My Orders</a>
                     </p>
                     <p style="margin-top:24px;"><strong>What you bought:</strong></p>
                     <ul style="padding-left:20px;line-height:1.7;">${itemList}</ul>
                     <p style="font-size:13px;color:#666;margin-top:24px;">For your security, downloads are tied to your account. Sign in with the email you used to place the order, then click the Download button on each item.</p>
                     <p style="font-size:13px;color:#666;">Your download window stays open for 30 days.</p>
                     <p style="margin-top:24px;">— The DigitalMarket Team</p>
                     </div>`
          });
          if (!result?.ok) {
            await db.collection('emailFailures').add({
              type: 'order_approved',
              orderId,
              toHash: hashEmail(buyerEmail),
              reason: result?.err || result?.message || 'unknown',
              createdAt: FieldValue.serverTimestamp()
            });
          }
        } catch (e) {
          await db.collection('emailFailures').add({
            type: 'order_approved',
            orderId,
            toHash: hashEmail(buyerEmail),
            reason: String(e.message || e),
            createdAt: FieldValue.serverTimestamp()
          }).catch(() => {});
          console.error(`[onOrderStatusChange] buyer email threw for ${orderId}:`, e.message);
        }
      }

      // Notify seller — also non-throwing.
      const sellerIds = after.sellerIds || [];
      await Promise.allSettled(sellerIds.map(sid =>
        db.collection('notifications').add({
          userId:    sid,
          type:      'new_sale',
          message:   `New sale! Order #${orderId.slice(0,8).toUpperCase()} approved.`,
          orderId,
          read:      false,
          createdAt: FieldValue.serverTimestamp()
        })
      ));

      // ── Real opt-in social-proof feed ────────────────────────────────
      // Only fires if the buyer ticked the "Show my first name in the
      // public ticker" checkbox at checkout. Stores first-name-only +
      // product name — never UID, never email, never last name.
      // The daily `cleanupPublicPurchases` scheduler removes entries
      // older than 30 days.
      if (after.publicAttribution === true) {
        try {
          const fullName  = String(after.buyerName || '').trim();
          // Sanity: first whitespace-separated token, max 20 chars,
          // letters+space only (block emoji / control chars). If we
          // can't derive a clean first name, just use "A buyer".
          let firstName = fullName.split(/\s+/)[0] || '';
          firstName = firstName.replace(/[^\p{L}\p{M}\- ]/gu, '').slice(0, 20).trim();
          if (!firstName) firstName = 'A buyer';

          // Take the first item's name (the "highlight" of the order).
          const showcase = (after.items || [])[0];
          if (showcase && showcase.name) {
            await db.collection('publicPurchases').add({
              firstName,
              productName: String(showcase.name).slice(0, 80),
              productId:   showcase.id || null,
              createdAt:   FieldValue.serverTimestamp(),
              // TTL for cleanup query — 30 days from now.
              expiresAt:   Date.now() + 30 * 86400000
            });
          }
        } catch (e) {
          console.warn(`[onOrderStatusChange] publicPurchases write failed for ${orderId}:`, e.message);
        }
      }
    }

    // ── Order rejected → notify buyer ──
    if (after.status === 'rejected') {
      const buyerEmail = after.buyerEmail || '';
      const buyerName  = after.buyerName  || 'Customer';
      const orderShort = orderId.slice(0,8).toUpperCase();
      const reason     = after.rejectionReason || '';
      if (buyerEmail) {
        try {
          await sendEmail({
            to: buyerEmail,
            subject: `Order update — #${orderShort}`,
            body: `<p>Hi ${buyerName},</p>
                   <p>Unfortunately your order <strong>#${orderShort}</strong> could not be verified at this time${reason ? ` for the following reason:<br><em>${reason}</em>` : '.'}</p>
                   <p>If you believe this is a mistake, reply to this email with a clearer screenshot of your payment confirmation and we will review again within one business day.</p>
                   <p>— The DigitalMarket Team</p>`
          });
        } catch (e) { console.warn(`[onOrderStatusChange:rejected] email failed:`, e.message); }
      }
      if (after.buyerId) {
        await db.collection('notifications').add({
          userId:    after.buyerId,
          type:      'order_rejected',
          message:   `Order #${orderShort} could not be verified. Check your email for details.`,
          orderId,
          read:      false,
          createdAt: FieldValue.serverTimestamp()
        }).catch(() => {});
      }
    }

    // ── Order refunded → notify buyer ──
    if (after.status === 'refunded') {
      const buyerEmail = after.buyerEmail || '';
      if (buyerEmail) {
        await sendEmail({
          to:      buyerEmail,
          subject: '↩ Refund processed – DigitalMarket',
          body:    `<p>Your refund for order #${orderId.slice(0,8).toUpperCase()} has been processed. Funds will appear within 5–10 business days.</p>`
        });
      }

      // Add notification for buyer
      if (after.buyerId) {
        await db.collection('notifications').add({
          userId:    after.buyerId,
          type:      'refund',
          message:   `Refund for order #${orderId.slice(0,8).toUpperCase()} has been processed.`,
          orderId,
          read:      false,
          createdAt: FieldValue.serverTimestamp()
        });
      }
    }
  }
);

// ─── 2. cleanExpiredDownloads ──────────────────────────────────────────────

exports.cleanExpiredDownloads = onSchedule(
  { schedule: 'every day 00:00', region: 'us-central1', timeZone: 'UTC' },
  async () => {
    const now  = Date.now();
    // SECURITY/CORRECTNESS: `!=` in Firestore skips docs missing the field.
    // Match on the explicit `false` value that onOrderStatusChange writes
    // at approval time (line 152: `downloadExpired: false`).
    const snap = await db.collection('orders')
      .where('downloadExpiresAt', '<=', now)
      .where('downloadExpired', '==', false)
      .limit(500)
      .get();

    if (snap.empty) { console.log('[cleanExpiredDownloads] Nothing to expire.'); return; }

    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { downloadExpired: true }));
    await batch.commit();
    console.log(`[cleanExpiredDownloads] Expired ${snap.size} orders.`);
  }
);

// ─── 3. onProductFileDelete ────────────────────────────────────────────────
// When a product file is deleted in Storage, clear the downloadUrl on all
// products that referenced that file (prevents dead links).

exports.onProductFileDelete = onObjectDeleted(
  { bucket: 'digitalmarket-38db5.firebasestorage.app', region: 'us-east1' },
  async event => {
    const filePath = event.data?.name;
    const size     = Number(event.data?.size || 0);
    if (!filePath || !filePath.startsWith('products/')) return;

    // Mirror of onProductFileFinalized: decrement the seller's quota counter
    // when a product file is removed, and re-enable uploads if they go back
    // below the cap.
    const m = filePath.match(/^products\/([^\/]+)\//);
    if (m && size > 0) {
      const sellerId = m[1];
      try {
        const userRef = db.collection('users').doc(sellerId);
        await db.runTransaction(async tx => {
          const snap = await tx.get(userRef);
          const prev = Number(snap.data()?.uploadBytesUsed || 0);
          const next = Math.max(0, prev - size);
          const update = { uploadBytesUsed: next };
          if (next < SELLER_UPLOAD_CAP_BYTES
              && snap.data()?.uploadDisabledReason === 'quota_exceeded') {
            update.uploadDisabled = false;
            update.uploadDisabledReason = FieldValue.delete();
          }
          tx.update(userRef, update);
        });
      } catch (e) {
        console.warn(`[onProductFileDelete] tally decrement failed for ${sellerId}:`, e.message);
      }
    }

    // PERFORMANCE: prefer an indexed lookup by `storagePath`. New uploads
    // should write this field; for legacy products without it we fall back
    // to a downloadUrl substring scan (capped) so we don't break anything.
    let cleared = 0;
    try {
      const byPath = await db.collection('products')
        .where('storagePath', '==', filePath)
        .limit(50)
        .get();
      if (!byPath.empty) {
        const batch = db.batch();
        byPath.docs.forEach(d => batch.update(d.ref, { downloadUrl: '', storagePath: FieldValue.delete() }));
        await batch.commit();
        cleared += byPath.size;
      }
    } catch (e) {
      // Index may not exist yet on first deploy — fall through to legacy scan.
      console.warn('[onProductFileDelete] storagePath query failed (index missing?):', e.message);
    }

    if (cleared === 0) {
      // Legacy fallback: scan products with a Firebase Storage URL. Capped
      // to 500 docs so a marketplace with 10k+ products doesn't OOM.
      const encodedPath = encodeURIComponent(filePath);
      const urlFragment = `o/${encodedPath}`;
      const snap = await db.collection('products')
        .where('downloadUrl', '>=', 'https://firebasestorage.googleapis.com')
        .limit(500)
        .get();
      const batch = db.batch();
      snap.docs.forEach(d => {
        if ((d.data().downloadUrl || '').includes(urlFragment)) {
          batch.update(d.ref, { downloadUrl: '' });
          cleared++;
        }
      });
      if (cleared > 0) await batch.commit();
    }
    console.log(`[onProductFileDelete] Cleared downloadUrl on ${cleared} product(s) for ${filePath}.`);
  }
);

// ─── 3a. onProductFileFinalized — tally seller bytes + MIME magic check ────
//
// Every successful upload triggers this. We:
//   (1) Tally the seller's running storage usage. If they pass the cap,
//       set `uploadDisabled: true` on their /users doc; the client UI uses
//       this to short-circuit further upload attempts. Hard cap: 10 GiB
//       per seller.
//   (2) Sniff the first 16 bytes of the file and verify the magic number
//       matches the claimed contentType. Catches `evil.exe` uploaded with
//       contentType: 'image/jpeg' (which bypassed our storage.rules MIME
//       allow-list since contentType is client-supplied).
//   (3) Stamp the product doc with a generated thumbnail/preview path if
//       relevant later; for now just an upload audit.

const SELLER_UPLOAD_CAP_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB / seller

// First-bytes magic numbers for the common contentTypes the storage rule
// allows. If the claimed type maps to a list of prefixes, ANY match passes.
const MAGIC = {
  'image/jpeg':       [[0xFF, 0xD8, 0xFF]],
  'image/jpg':        [[0xFF, 0xD8, 0xFF]],
  'image/png':        [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  'image/gif':        [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  'image/webp':       [[0x52, 0x49, 0x46, 0x46]], // RIFF + WEBP later in header
  'application/pdf':  [[0x25, 0x50, 0x44, 0x46]],
  'application/zip':  [[0x50, 0x4B, 0x03, 0x04], [0x50, 0x4B, 0x05, 0x06], [0x50, 0x4B, 0x07, 0x08]],
  'video/mp4':        [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]],
  'audio/mpeg':       [[0x49, 0x44, 0x33], [0xFF, 0xFB], [0xFF, 0xF3]]
};

function matchesMagic(declared, headBytes) {
  // Normalize: text/*, font/* are usually fine without magic check.
  if (!declared) return true;
  if (declared.startsWith('text/')) return true;
  if (declared.startsWith('font/')) return true;
  // Some Office docs report application/octet-stream or vendor types — skip.
  if (declared === 'application/octet-stream') return true;
  const expected = MAGIC[declared];
  if (!expected) return true; // unknown declared type — don't false-positive
  return expected.some(prefix =>
    prefix.every((byte, i) => headBytes[i] === byte)
  );
}

exports.onProductFileFinalized = onObjectFinalized(
  { bucket: 'digitalmarket-38db5.firebasestorage.app', region: 'us-east1' },
  async event => {
    const path  = event.data?.name;
    const size  = Number(event.data?.size || 0);
    const ctype = event.data?.contentType || '';
    if (!path) return;

    // Only meter /products/{uid}/* and /kyc/{uid}/* (where rules say sellers
    // can upload). Skip /proofs (small images, capped, not seller storage).
    const m = path.match(/^(products|kyc)\/([^\/]+)\//);
    if (!m) return;
    const sellerId = m[2];

    // MIME magic check (skip if file too small to bother).
    if (size > 16) {
      try {
        const bucket = getStorage().bucket(event.data.bucket);
        const [headBuf] = await bucket.file(path).download({ start: 0, end: 15 });
        if (!matchesMagic(ctype, headBuf)) {
          console.warn(`[onProductFileFinalized] MIME mismatch: declared=${ctype} for ${path} — deleting`);
          await bucket.file(path).delete().catch(() => {});
          await db.collection('uploadViolations').add({
            sellerId,
            path,
            declaredType: ctype,
            firstBytes: Array.from(headBuf.slice(0, 8)).map(b => b.toString(16).padStart(2,'0')).join(''),
            createdAt: FieldValue.serverTimestamp()
          }).catch(() => {});
          return;
        }
      } catch (e) {
        console.warn(`[onProductFileFinalized] magic-check failed for ${path}:`, e.message);
      }
    }

    // Tally seller bytes and gate further uploads at the cap.
    try {
      const userRef = db.collection('users').doc(sellerId);
      await db.runTransaction(async tx => {
        const snap = await tx.get(userRef);
        const prev = Number(snap.data()?.uploadBytesUsed || 0);
        const next = prev + size;
        const update = { uploadBytesUsed: next };
        if (next >= SELLER_UPLOAD_CAP_BYTES && !snap.data()?.uploadDisabled) {
          update.uploadDisabled = true;
          update.uploadDisabledReason = 'quota_exceeded';
          update.uploadDisabledAt = FieldValue.serverTimestamp();
        }
        tx.update(userRef, update);
      });
    } catch (e) {
      console.warn(`[onProductFileFinalized] tally failed for ${sellerId}:`, e.message);
    }
  }
);

// ─── 3b. onProductDocDelete — cleans up orphan Storage objects ──────────────
// Inverse of onProductFileDelete: when a product Firestore doc is deleted,
// delete its associated Storage file too. Previously a seller could delete
// the doc, leaving the file orphaned forever (still downloadable via the
// long-lived token URL — and counted toward the marketplace storage bill).
exports.onProductDocDelete = onDocumentDeleted(
  { document: 'products/{productId}', region: 'us-central1' },
  async event => {
    const data = event.data?.data();
    if (!data) return;
    const path = data.storagePath;
    if (!path || typeof path !== 'string' || !path.startsWith('products/')) {
      // No tracked path — nothing to clean. Legacy products without
      // storagePath leak storage; admin can sweep manually.
      return;
    }
    try {
      const bucket = require('firebase-admin').storage().bucket('digitalmarket-38db5.firebasestorage.app');
      await bucket.file(path).delete();
      console.log(`[onProductDocDelete] Deleted orphan storage object ${path}.`);
    } catch (e) {
      // 404 is fine (already deleted via the storage trigger).
      if (!/No such object|404/.test(String(e.message || e))) {
        console.error(`[onProductDocDelete] Failed deleting ${path}:`, e.message);
      }
    }
  }
);

// ─── 4. onNewReview ────────────────────────────────────────────────────────
// Recomputes ratingAvg + ratingCount on the parent product after any review write.

exports.onNewReview = onDocumentWritten(
  { document: 'reviews/{reviewId}', region: 'us-central1' },
  async event => {
    const data = event.data?.after?.data() || event.data?.before?.data();
    if (!data?.productId) return;

    const productId = data.productId;

    // Aggregate all ratings for this product
    const snap = await db.collection('reviews')
      .where('productId', '==', productId)
      .get();

    if (snap.empty) {
      await db.collection('products').doc(productId).update({ ratingAvg: 0, ratingCount: 0 });
      return;
    }

    const ratings    = snap.docs.map(d => Number(d.data().rating || 0)).filter(r => r > 0);
    const ratingCount = ratings.length;
    const ratingAvg  = ratingCount > 0
      ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratingCount) * 10) / 10
      : 0;

    await db.collection('products').doc(productId)
      .update({ ratingAvg, ratingCount });

    console.log(`[onNewReview] Product ${productId}: avg=${ratingAvg} count=${ratingCount}`);
  }
);

// ─── 5. generateSitemap (HTTPS Callable) ──────────────────────────────────

// ─── 6. abandonedCartReminder ─────────────────────────────────────────
// Daily check: emails users whose cart has been idle ≥ 24h and isn't notified yet.

exports.abandonedCartReminder = onSchedule(
  { schedule: 'every day 10:00', region: 'us-central1', timeZone: 'Africa/Cairo', secrets: EMAIL_SECRETS },
  async () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const snap = await db.collection('abandonedCarts')
      .where('notified', '==', false)
      .limit(200)
      .get();

    let sent = 0;
    for (const doc of snap.docs) {
      const c = doc.data();
      const updatedMs = c.updatedAt?.toMillis ? c.updatedAt.toMillis() : 0;
      if (updatedMs > cutoff) continue; // too recent

      // CORRECTNESS: only mark `notified` after a successful send. Previous
      // logic flipped the flag unconditionally, so carts with no email
      // (or where Resend returned 4xx/5xx) were permanently silenced.
      if (!c.email) continue;
      const result = await sendEmail({
        to:      c.email,
        subject: '🛒 You left something in your cart',
        body:    `<p>Hi there,</p>
                 <p>You left <strong>${(c.items||[]).length} item${(c.items||[]).length===1?'':'s'}</strong> in your cart at DigitalMarket.</p>
                 <p>Use code <code>COMEBACK10</code> for 10% off — valid for 48 hours.</p>
                 <p><a href="https://digitalmarketstore.shop/?utm_source=cart_recovery">Return to your cart →</a></p>`
      }).catch(e => ({ ok: false, err: String(e?.message || e) }));
      if (result?.ok) {
        sent++;
        await doc.ref.update({ notified: true, notifiedAt: FieldValue.serverTimestamp() });
      } else {
        console.warn(`[abandonedCartReminder] Send failed for ${c.email}:`, result?.err || result);
      }
    }
    console.log(`[abandonedCartReminder] Sent ${sent} reminder(s).`);
  }
);

// ─── 7. processEmailCampaigns ─────────────────────────────────────────
// Picks up queued campaigns and dispatches via SendGrid (or your provider).

exports.processEmailCampaigns = onSchedule(
  {
    schedule: 'every 5 minutes',
    region: 'us-central1',
    secrets: EMAIL_SECRETS,
    // RELIABILITY: 2000 recipients × ~200ms/send = 400s. Default 60s timeout
    // would cut campaigns mid-send and leave them stuck in `sending` forever.
    // Bumped to 540s (max for 2nd-gen scheduled). Memory bumped to 512MB
    // because a 2000-doc snapshot of /newsletter or /users with all fields
    // pulls 10-20MB into JS heap.
    timeoutSeconds: 540,
    memory: '512MiB'
  },
  async () => {
    const queued = await db.collection('campaigns').where('status','==','queued').limit(5).get();
    if (queued.empty) return;

    for (const camp of queued.docs) {
      // RELIABILITY: claim the campaign transactionally so two overlapping
      // invocations of this scheduler can't both pick up the same row
      // and double-send. The previous read-then-update was non-atomic.
      let c;
      try {
        c = await db.runTransaction(async tx => {
          const snap = await tx.get(camp.ref);
          if (snap.data()?.status !== 'queued') return null; // someone else claimed
          tx.update(camp.ref, { status: 'sending', startedAt: FieldValue.serverTimestamp() });
          return snap.data();
        });
      } catch (e) {
        console.warn(`[processEmailCampaigns] claim failed for ${camp.id}:`, e.message);
        continue;
      }
      if (!c) continue; // claimed by a parallel worker

      try {
        let emails = [];
        // MEMORY: use .select() projection so we only pull the email field
        // (was previously loading entire user docs into memory, including
        // KYC fields).
        if (c.target === 'all') {
          const s = await db.collection('newsletter').select('email').limit(2000).get();
          emails = s.docs.map(d => d.data().email).filter(Boolean);
        } else if (c.target === 'buyers' || c.target === 'sellers') {
          const role = c.target.slice(0, -1);
          const s = await db.collection('users').where('role','==',role).select('email').limit(2000).get();
          emails = s.docs.map(d => d.data().email).filter(Boolean);
        }

        // OBSERVABILITY: track per-batch failures + write to /emailFailures
        // for the ones that returned non-ok so an admin can re-send.
        let failures = 0;
        for (let i = 0; i < emails.length; i += 50) {
          const batch = emails.slice(i, i + 50);
          const results = await Promise.all(batch.map(to =>
            sendEmail({ to, subject: c.subject, body: c.body })
              .then(r => ({ to, r }))
              .catch(err => ({ to, r: { ok: false, err: String(err?.message || err) } }))
          ));
          for (const { to, r } of results) {
            if (!r?.ok) {
              failures++;
              await db.collection('emailFailures').add({
                type: 'campaign',
                campaignId: camp.id,
                toHash: hashEmail(to),
                reason: r?.err || r?.reason || `status:${r?.status}` || 'unknown',
                createdAt: FieldValue.serverTimestamp()
              }).catch(() => {});
            }
          }
        }

        await camp.ref.update({
          status: 'sent',
          sentAt: FieldValue.serverTimestamp(),
          actualRecipientCount: emails.length,
          failureCount: failures
        });
        console.log(`[processEmailCampaigns] Campaign ${camp.id}: sent ${emails.length - failures}/${emails.length} (${failures} failed).`);
      } catch (err) {
        await camp.ref.update({ status: 'failed', error: String(err.message || err) }).catch(() => {});
        console.error(`[processEmailCampaigns] Campaign ${camp.id} failed:`, err);
      }
    }
  }
);

// ─── 8. cleanupPresence ───────────────────────────────────────────────
// Removes expired presence docs (TTL via expiresAt field).

exports.cleanupPresence = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1' },
  async () => {
    const now = Date.now();
    const snap = await db.collection('presence').where('expiresAt','<', now).limit(500).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`[cleanupPresence] Removed ${snap.size} expired presence docs.`);
  }
);

// ─── 9. onKYCApproval ─────────────────────────────────────────────────
// Fires when admin approves/rejects a KYC request; mirrors decision to user doc.

// ─── 10. mirrorPublicProfile ──────────────────────────────────────────
// On every /users/{uid} write, mirror ONLY safe fields to /publicProfiles/{uid}
// so unauthenticated visitors can view seller storefronts WITHOUT exposing
// KYC docs, bank info, phone, email, etc.

const PUBLIC_FIELDS = [
  'name', 'shopName', 'shopDesc', 'bio', 'avatarUrl', 'photoURL',
  'role', 'verified', 'totalSales', 'tier',
  'ratingAvg', 'ratingCount',
  'instapay',  // payment-only contact ok to expose so buyers can pay
  'createdAt',
];

exports.mirrorPublicProfile = onDocumentWritten(
  { document: 'users/{userId}', region: 'us-central1' },
  async event => {
    const after = event.data?.after?.data();
    const userId = event.params.userId;

    if (!after) {
      // User deleted — also delete the public profile
      await db.collection('publicProfiles').doc(userId).delete().catch(() => {});
      return;
    }

    // Skip mirror for buyers (only sellers need a public profile).
    // ALSO delete any stale public profile in case of seller→buyer downgrade,
    // otherwise the old shop data stays publicly visible indefinitely.
    if (after.role !== 'seller' && after.role !== 'admin') {
      await db.collection('publicProfiles').doc(userId).delete().catch(() => {});
      return;
    }

    const publicData = {};
    for (const k of PUBLIC_FIELDS) {
      if (k in after) publicData[k] = after[k];
    }
    publicData.updatedAt = FieldValue.serverTimestamp();

    await db.collection('publicProfiles').doc(userId).set(publicData, { merge: true });
  }
);

exports.onKYCApproval = onDocumentWritten(
  { document: 'kycRequests/{reqId}', region: 'us-central1' },
  async event => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!after || before?.status === after.status) return;
    if (!after.userId) return;

    const userRef = db.collection('users').doc(after.userId);
    await userRef.update({
      kycStatus: after.status,
      kycRejectReason: after.rejectReason || '',
      kycReviewedAt: FieldValue.serverTimestamp()
    });

    // Notify the user
    await db.collection('notifications').add({
      userId:    after.userId,
      type:      'kyc_' + after.status,
      message:   after.status === 'verified'
        ? '🎉 Your identity has been verified! Higher payouts now unlocked.'
        : `❌ KYC was rejected: ${after.rejectReason || 'please contact support'}`,
      read:      false,
      createdAt: FieldValue.serverTimestamp()
    });
  }
);

// ─── 11. emailHealthCheck (admin-only callable) ───────────────────────
// Sends a test email through Resend to verify domain + key setup end-to-end.
// Call from admin UI after DNS records propagate.
exports.emailHealthCheck = onCall(
  { region: 'us-central1', secrets: EMAIL_SECRETS, cors: ['https://digitalmarketstore.shop'] },
  async req => {
    // Admin gate
    const uid = req.auth?.uid;
    if (!uid) throw new Error('Sign in required');
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.data()?.role !== 'admin') throw new Error('Admin only');

    const to = req.data?.to || req.auth.token.email;
    if (!to) throw new Error('Provide a "to" email address');

    const result = await sendEmail({
      to,
      subject: `DigitalMarket email health check — ${new Date().toISOString().slice(0,16)}`,
      body: `<div style="font-family:sans-serif;padding:20px;background:#f5f5f5;">
        <h2 style="color:#6366f1;">✅ Email delivery working!</h2>
        <p>If you received this, your Resend (or SendGrid) integration is fully operational.</p>
        <p>Triggered by admin <code>${uid.slice(0,8)}…</code> at ${new Date().toISOString()}.</p>
      </div>`
    });
    return result;
  }
);

exports.generateSitemap = onCall(
  { region: 'us-central1', cors: ['https://digitalmarketstore.shop'] },
  async req => {
    // SECURITY: admin-only. Previously this was effectively public — every
    // call ran an unbounded 1000-doc Firestore read, so an attacker could
    // amplify Firestore reads from outside the org. The GitHub Actions
    // sitemap workflow uses Firestore REST directly (see .github/workflows/
    // sitemap.yml) so this callable is now an admin-side utility only.
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.data()?.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Admins only.');
    }

    const BASE = 'https://digitalmarketstore.shop';
    const snap = await db.collection('products')
      .where('status', '==', 'approved')
      .orderBy('createdAt', 'desc')
      .limit(1000)
      .get();

    const staticPages = [
      { loc: BASE + '/',            changefreq: 'daily',  priority: '1.0' },
      { loc: BASE + '/terms.html',  changefreq: 'monthly',priority: '0.3' },
      { loc: BASE + '/privacy.html',changefreq: 'monthly',priority: '0.3' },
    ];

    const productUrls = snap.docs.map(d => ({
      loc:        `${BASE}/?p=${d.id}`,
      changefreq: 'weekly',
      priority:   '0.8',
      lastmod:    d.data().updatedAt?.toDate
        ? d.data().updatedAt.toDate().toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0]
    }));

    const allUrls = [...staticPages, ...productUrls];

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...allUrls.map(u =>
        `  <url>\n    <loc>${u.loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
      ),
      '</urlset>'
    ].join('\n');

    return { sitemap: xml, count: allUrls.length };
  }
);

// ─── 11. downloadFile — gated proxy for product downloads ──────────────────
//
// SECURITY: Firebase Storage's `getDownloadURL()` returns a token URL that
// never expires. Once a buyer (or anyone with the URL) has it, they keep
// access forever — making the `downloadExpired` flag on orders cosmetic.
//
// This HTTPS endpoint replaces direct URL handoff: every download request
// must include the order's `downloadToken` and the requester must be the
// order's buyerId. We then re-verify:
//   (a) order status == 'approved'
//   (b) downloadExpired == false
//   (c) downloadExpiresAt > now
//   (d) productId is in order.items
// before streaming the file from a server-side-only Storage path. The
// public `downloadUrl` field is no longer the source of truth.
//
// Client usage:
//   POST /downloadFile
//   Authorization: Bearer <firebase-id-token>
//   { orderId, productId, token }
//
// Returns: a 302 redirect to a fresh 5-minute signed URL (V4) so the
// browser can perform the actual download with full streaming + Range
// header support. The signed URL is single-use-ish (still valid 5 min
// for resumes) and tied to a specific Storage path that buyers cannot
// guess.

exports.downloadFile = onRequest(
  {
    region: 'us-central1',
    cors: ['https://digitalmarketstore.shop'],
    timeoutSeconds: 60,
    memory: '256MiB',
    // Bind Drive secret so per-buyer sharing works when configured.
    // No-op if GDRIVE_SA_JSON isn't set — falls back to public Drive URL.
    secrets: DRIVE_SECRETS
  },
  async (req, res) => {
    // Manual CORS handling — onRequest's `cors` config covers preflight but
    // we set explicit headers for the actual response.
    res.set('Access-Control-Allow-Origin', 'https://digitalmarketstore.shop');
    res.set('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return res.status(204).send('');
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });

    // 1. Auth: require a Firebase ID token.
    const authHeader = req.headers.authorization || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'unauthenticated', message: 'Bearer token required.' });

    let decoded;
    try {
      decoded = await require('firebase-admin').auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'invalid-token', message: 'ID token failed verification.' });
    }
    const uid = decoded.uid;

    // 2. Body validation.
    const { orderId, productId, token } = req.body || {};
    if (!orderId || !productId || !token) {
      return res.status(400).json({ error: 'missing-fields', message: 'orderId, productId, token are all required.' });
    }

    // 3. Order lookup + ownership check.
    let order;
    try {
      const snap = await db.collection('orders').doc(orderId).get();
      if (!snap.exists) return res.status(404).json({ error: 'order-not-found' });
      order = snap.data();
    } catch (e) {
      console.error('[downloadFile] order lookup failed:', e.message);
      return res.status(500).json({ error: 'lookup-failed' });
    }

    if (order.buyerId !== uid) {
      return res.status(403).json({ error: 'not-your-order' });
    }
    if (order.status !== 'approved') {
      return res.status(403).json({ error: 'order-not-approved', status: order.status });
    }

    // 4. Token check (constant-time).
    //
    // BACKFILL: orders approved before the idempotent token-issue logic
    // shipped (any approved order without a `downloadToken` field) skip
    // this layer of defense. The other gates (ID token verify, buyerId
    // match, status=approved, expiry, productId in order) are sufficient
    // for those legacy orders. After the first successful download we
    // generate a token and save it to the order so future requests have
    // full defense.
    const crypto = require('crypto');
    let needsTokenBackfill = false;
    if (order.downloadToken) {
      const okToken = (() => {
        const a = Buffer.from(String(order.downloadToken), 'utf8');
        const b = Buffer.from(String(token || ''), 'utf8');
        if (a.length !== b.length) return false;
        try { return crypto.timingSafeEqual(a, b); } catch { return false; }
      })();
      if (!okToken) return res.status(403).json({ error: 'bad-token' });
    } else {
      // Legacy approved order — no token persisted yet.
      needsTokenBackfill = true;
    }

    // 5. Expiry check (now the AUTHORITATIVE gate — replaces the cosmetic
    //    downloadExpired flag that the public URL ignored entirely).
    const now = Date.now();
    if (order.downloadExpired === true) return res.status(410).json({ error: 'expired', message: 'Download window closed.' });
    if (order.downloadExpiresAt && order.downloadExpiresAt < now) {
      // Mark expired so the daily cleaner doesn't have to.
      await db.collection('orders').doc(orderId).update({ downloadExpired: true }).catch(() => {});
      return res.status(410).json({ error: 'expired', message: 'Download window closed.' });
    }
    // If the legacy order has no expiry either, set a 30-day window now.
    if (!order.downloadExpiresAt) {
      const newExpiry = now + 30 * 86400000;
      await db.collection('orders').doc(orderId).update({
        downloadExpiresAt: newExpiry,
        downloadExpired: false
      }).catch(() => {});
    }
    // Backfill the token if missing — generated fresh and saved to the doc.
    if (needsTokenBackfill) {
      const newToken = crypto.randomUUID();
      await db.collection('orders').doc(orderId).update({
        downloadToken: newToken
      }).catch(e => console.warn('[downloadFile] token backfill write failed:', e.message));
    }

    // 6. Product must be in this order.
    const item = (order.items || []).find(i => i.id === productId);
    if (!item) return res.status(403).json({ error: 'product-not-in-order' });

    // 7. Resolve the download URL.
    //
    // The seller chooses where the file actually lives: Google Drive,
    // Dropbox, S3, Firebase Storage, anything reachable by URL. We just
    // pass through whatever `product.downloadUrl` is set to (with auth
    // + ownership + expiry gates already validated above).
    //
    // If the URL points at Firebase Storage we still want to issue a
    // short-lived signed URL (so it expires + carries
    // Content-Disposition: attachment); for everything else we return
    // the URL as-is and the browser opens it in a new tab.
    let downloadUrl;
    let storagePath;
    let provider = 'unknown';
    let diagnostic = '';
    try {
      const prodSnap = await db.collection('products').doc(productId).get();
      const prod     = prodSnap.data() || {};
      // Prefer the seller's current setting; fall back to the order's
      // snapshot at purchase time if the product was edited or removed.
      downloadUrl = prod.downloadUrl || item.downloadUrl || '';
      storagePath = prod.storagePath || item.storagePath || '';
      diagnostic = `prod_has_url=${!!prod.downloadUrl}, prod_has_path=${!!prod.storagePath}, item_has_url=${!!item.downloadUrl}`;
    } catch (e) {
      console.error('[downloadFile] product lookup failed:', e.message);
      return res.status(500).json({ error: 'product-lookup-failed', detail: e.message });
    }

    if (!downloadUrl && !storagePath) {
      console.warn(`[downloadFile] no URL for product ${productId} in order ${orderId} — ${diagnostic}`);
      return res.status(404).json({
        error: 'file-not-available',
        message: 'The seller has not set a download link for this product yet, or it was removed. Please contact support.',
        diagnostic
      });
    }

    // Detect provider for analytics + correct handling.
    const safeName = (item.name || 'file').replace(/[^\w.\- ]/g, '_');
    if (/drive\.google\.com|docs\.google\.com/i.test(downloadUrl)) {
      provider = 'gdrive';
    } else if (/firebasestorage\.googleapis\.com/i.test(downloadUrl) || storagePath) {
      provider = 'firebase';
    } else if (/dropbox\.com/i.test(downloadUrl)) {
      provider = 'dropbox';
    } else if (downloadUrl) {
      provider = 'external';
    }

    // Audit every successful download attempt (CF reaches this only after
    // all auth/ownership/expiry gates passed).
    db.collection('downloadLog').add({
      orderId,
      productId,
      buyerId:  uid,
      provider,
      at:       FieldValue.serverTimestamp(),
      ip:       req.ip || req.headers['x-forwarded-for'] || ''
    }).catch(() => {});

    // Firebase Storage → issue a 5-minute signed URL so it expires.
    if (provider === 'firebase' && storagePath && storagePath.startsWith('products/')) {
      try {
        const bucket = getStorage().bucket('digitalmarket-38db5.firebasestorage.app');
        const [exists] = await bucket.file(storagePath).exists();
        if (!exists) {
          return res.status(404).json({
            error: 'file-not-available',
            message: 'The file is missing from storage. Please contact support so the seller can re-upload.',
            path: storagePath
          });
        }
        const [signedUrl] = await bucket.file(storagePath).getSignedUrl({
          version:  'v4',
          action:   'read',
          expires:  Date.now() + 5 * 60 * 1000,
          responseDisposition: `attachment; filename="${safeName}"`
        });
        return res.status(200).json({ ok: true, signedUrl, filename: safeName, provider, expiresIn: 300, openIn: 'download' });
      } catch (e) {
        console.error('[downloadFile] firebase sign failed:', e.message);
        // Fall through to returning the public URL as a last resort
      }
    }

    if (!downloadUrl) {
      return res.status(404).json({
        error: 'file-not-available',
        message: 'No working download link is available. Please contact support.',
        diagnostic
      });
    }

    // Google Drive: when GDRIVE_SA_JSON secret is configured, share the
    // file directly with the buyer's email and record the grant so we
    // can revoke after 30 days. Falls back to the public link if the
    // service account isn't set up, the URL isn't a recognized Drive
    // shape, or the share API call fails.
    if (provider === 'gdrive' && getDriveClient()) {
      const fileId = extractDriveFileId(downloadUrl);
      const buyerEmail = order.buyerEmail || '';
      if (fileId && buyerEmail) {
        const grantKey = `${orderId}__${productId}`;
        try {
          const existing = await db.collection('driveGrants').doc(grantKey).get();
          let permissionId = existing.exists ? existing.data()?.permissionId : null;
          if (!permissionId) {
            permissionId = await grantDriveAccess(fileId, buyerEmail);
            if (permissionId) {
              await db.collection('driveGrants').doc(grantKey).set({
                orderId,
                productId,
                fileId,
                permissionId,
                buyerId:    uid,
                buyerEmail,                                 // needed for re-share if user re-orders
                buyerEmailHash: hashEmail(buyerEmail),
                grantedAt:  FieldValue.serverTimestamp(),
                expiresAt:  Date.now() + 30 * 86400000,    // 30-day matched to order window
                revokedAt:  null
              });
            }
          }
          if (permissionId) {
            // Direct download URL works for files with view permission.
            const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
            return res.status(200).json({
              ok: true,
              signedUrl: directUrl,
              filename:  safeName,
              provider:  'gdrive-restricted',
              openIn:    'tab',
              expiresIn: 30 * 86400
            });
          }
        } catch (e) {
          console.warn('[downloadFile] gdrive grant flow failed:', e.message);
          // fall through to public-URL return below
        }
      }
    }

    // Default: return the URL as-is and let the client open in a new tab.
    return res.status(200).json({
      ok: true,
      signedUrl: downloadUrl,
      filename:  safeName,
      provider,
      // For Drive/Dropbox/external we open in a new tab — the platform's
      // own viewer / download button takes over. For firebase we trigger
      // the save dialog directly.
      openIn: provider === 'firebase' ? 'download' : 'tab'
    });
  }
);

// ─── 12. revokeExpiredDriveGrants — daily cleanup ──────────────────────────
// Revokes Drive permissions granted by downloadFile that are >30 days old.
// Marks the grant doc with `revokedAt` so we don't try again on the next
// run. Idempotent + 404-tolerant.
exports.revokeExpiredDriveGrants = onSchedule(
  { schedule: 'every day 02:00', region: 'us-central1', timeZone: 'UTC', secrets: DRIVE_SECRETS },
  async () => {
    const drive = getDriveClient();
    if (!drive) {
      console.log('[revokeExpiredDriveGrants] GDRIVE_SA_JSON not set — skipping.');
      return;
    }
    const now = Date.now();
    const snap = await db.collection('driveGrants')
      .where('revokedAt', '==', null)
      .where('expiresAt', '<=', now)
      .limit(200)
      .get();
    if (snap.empty) { console.log('[revokeExpiredDriveGrants] nothing to revoke.'); return; }
    let revoked = 0;
    for (const doc of snap.docs) {
      const g = doc.data();
      const ok = await revokeDriveAccess(g.fileId, g.permissionId);
      await doc.ref.update({
        revokedAt: FieldValue.serverTimestamp(),
        revokeOk: ok
      }).catch(() => {});
      if (ok) revoked++;
    }
    console.log(`[revokeExpiredDriveGrants] revoked ${revoked} of ${snap.size} expired grants.`);
  }
);

// ─── 13. cleanupPublicPurchases — TTL on social-proof feed ─────────────────
// Removes /publicPurchases entries older than 30 days. Keeps the ticker
// fresh + prevents the collection from growing unbounded.
exports.cleanupPublicPurchases = onSchedule(
  { schedule: 'every day 01:00', region: 'us-central1', timeZone: 'UTC' },
  async () => {
    const now = Date.now();
    const snap = await db.collection('publicPurchases')
      .where('expiresAt', '<=', now)
      .limit(500)
      .get();
    if (snap.empty) { console.log('[cleanupPublicPurchases] nothing to clean.'); return; }
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`[cleanupPublicPurchases] removed ${snap.size} expired entries.`);
  }
);

// ─── 14. notifyIndexNow — instant Bing / DuckDuckGo / Yandex indexing ────
// Bing supports the IndexNow protocol: ping a single URL with the
// product URL and Bing indexes it in ~30 seconds (vs ~24h waiting
// for the next sitemap re-crawl). DuckDuckGo and Yandex also use
// this signal. Google does NOT (sticks with sitemap.xml only).
//
// Setup (one-time, done by the user):
//   1. https://www.bing.com/indexnow → click "Generate API key"
//   2. Bing returns a UUID-shaped key, e.g. `a1b2c3d4...`
//   3. firebase functions:secrets:set INDEXNOW_KEY
//   4. Host the key at https://digitalmarketstore.shop/{key}.txt
//      with the SAME string as the content (proves ownership).
//      We commit that file to the repo.
//   5. firebase deploy --only functions:notifyIndexNow
//
// Trigger: any /products document write where status flips to
// 'approved' — new listings and re-approvals after admin edits.
const INDEXNOW_KEY = defineSecret('INDEXNOW_KEY');

exports.notifyIndexNow = onDocumentWritten(
  { document: 'products/{productId}', region: 'us-central1', secrets: [INDEXNOW_KEY] },
  async event => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!after) return;                        // deletion — skip
    // Fire ONLY when status transitions to approved (not on every edit
    // of an already-approved product — that would burn the IndexNow
    // daily quota of 10k pings).
    const wasApproved = before?.status === 'approved';
    const isApproved  = after.status   === 'approved';
    if (!isApproved || wasApproved) return;

    const key = process.env.INDEXNOW_KEY;
    if (!key || key === '{}' || key === 'null') {
      console.log('[notifyIndexNow] INDEXNOW_KEY not set — skipping ping.');
      return;
    }
    const productId = event.params.productId;
    const host = 'digitalmarketstore.shop';
    const productUrl = `https://${host}/?p=${encodeURIComponent(productId)}`;

    try {
      const r = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host,
          key,
          keyLocation: `https://${host}/${key}.txt`,
          urlList: [productUrl]
        })
      });
      // IndexNow returns 200/202 on success, 400-422 on bad request,
      // 429 if rate-limited. Log all for observability.
      console.log(`[notifyIndexNow] product ${productId.slice(0,8)} → IndexNow HTTP ${r.status}`);
    } catch (e) {
      console.warn(`[notifyIndexNow] ping failed for ${productId}:`, e.message);
    }
  }
);

// ─── 11. scheduledFirestoreBackup ─────────────────────────────────────
// Exports every Firestore collection to a Cloud Storage bucket once a
// day. Retention is managed by a GCS lifecycle rule on the bucket itself
// (configure: 30-day delete). If the bucket doesn't exist or the SA
// lacks the `Cloud Datastore Import Export Admin` role, the call throws
// and the function fails — a Firebase Functions error notification is
// then your alert.
//
// One-time setup (run from Cloud Shell or local with gcloud auth):
//   gcloud storage buckets create gs://digitalmarket-38db5-backups \
//     --location=us-central1 --uniform-bucket-level-access
//   gcloud projects add-iam-policy-binding digitalmarket-38db5 \
//     --member="serviceAccount:digitalmarket-38db5@appspot.gserviceaccount.com" \
//     --role="roles/datastore.importExportAdmin"
//   gsutil lifecycle set <(echo '{"rule":[{"action":{"type":"Delete"},
//     "condition":{"age":30}}]}') gs://digitalmarket-38db5-backups

const firestoreAdminClient =
  new (require('@google-cloud/firestore').v1.FirestoreAdminClient)();

exports.scheduledFirestoreBackup = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'Africa/Cairo', region: 'us-central1' },
  async () => {
    const projectId = process.env.GCLOUD_PROJECT || 'digitalmarket-38db5';
    const databaseName = firestoreAdminClient.databasePath(projectId, '(default)');
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const outputUriPrefix = `gs://${projectId}-backups/firestore/${today}`;

    const [operation] = await firestoreAdminClient.exportDocuments({
      name: databaseName,
      outputUriPrefix,
      collectionIds: [] // empty = all collections
    });
    console.log(`[backup] Started → ${outputUriPrefix}; op=${operation.name}`);
  }
);
