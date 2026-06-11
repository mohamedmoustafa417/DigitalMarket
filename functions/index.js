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
const { getAuth }                = require('firebase-admin/auth');

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

// ─── Kashier payment gateway ────────────────────────────────────────────────
// Two values, set ONE-TIME from your terminal (the KEY is sensitive — it signs
// every payment hash + validates every webhook, so it MUST stay server-side
// only, never in index.html):
//   firebase functions:secrets:set KASHIER_MID           # e.g. MID-xxxx-xxxx
//   firebase functions:secrets:set KASHIER_PAYMENT_KEY   # the Payment API key
//   firebase deploy --only functions
// KASHIER_MODE stays 'test' until we've proven a full sandbox payment end-to-end;
// flip to 'live' (one-line edit + redeploy) when you're ready to take real money.
// Kashier issues TWO keys per mode:
//   • Payment API Key → generates the payment hash + validates the webhook
//     x-kashier-signature.  (KASHIER_PAYMENT_KEY)
//   • Secret Key       → authorizes server-to-server API calls (refunds).
//     (KASHIER_SECRET_KEY — only used by kashierRefund)
const KASHIER_MID         = defineSecret('KASHIER_MID');
const KASHIER_PAYMENT_KEY = defineSecret('KASHIER_PAYMENT_KEY');
const KASHIER_SECRET_KEY  = defineSecret('KASHIER_SECRET_KEY');
const KASHIER_SECRETS     = [KASHIER_MID, KASHIER_PAYMENT_KEY];                       // webhook (signature)
const KASHIER_FULL_SECRETS = [KASHIER_MID, KASHIER_PAYMENT_KEY, KASHIER_SECRET_KEY];  // create-session + refund (need both keys)
const KASHIER_MODE        = 'live';   // LIVE — real payments (was 'test')
const SITE_ORIGIN         = 'https://digitalmarketstore.shop';
const KASHIER_BRAND_COLOR = '#6366f1'; // matches the site --primary
// Kashier API hosts. Test vs live.
const KASHIER_API_BASE    = KASHIER_MODE === 'live'   // Payment Sessions
  ? 'https://api.kashier.io'
  : 'https://test-api.kashier.io';
const KASHIER_FEP_BASE    = KASHIER_MODE === 'live'   // refunds (FEP)
  ? 'https://fep.kashier.io'
  : 'https://test-fep.kashier.io';
// Payout (transfers) — kept on its OWN mode flag so we can prove seller
// disbursements in the Kashier SANDBOX while live payments keep running.
// Flip to 'live' ONLY after a full test-mode transfer + webhook round-trip.
const KASHIER_PAYOUT_MODE = 'test';
const KASHIER_PAYOUT_BASE = KASHIER_PAYOUT_MODE === 'live'
  ? 'https://fep.kashier.io'
  : 'https://test-fep.kashier.io';

/**
 * Kashier HPP order hash — HMAC-SHA256 over the canonical
 * `/?payment=${mid}.${orderId}.${amount}.${currency}` path, keyed with the
 * Payment API key. Verified against Kashier's published test vector
 * (/?payment=mid-0-1.99.20.EGP, secret 11111 → 606a8a13…e4bec).
 */
function kashierOrderHash(mid, orderId, amount, currency, key) {
  const path = `/?payment=${mid}.${orderId}.${amount}.${currency}`;
  return require('crypto').createHmac('sha256', key).update(path).digest('hex');
}

/**
 * Validate a Kashier webhook signature. Kashier tells us WHICH fields it signed
 * via `data.signatureKeys`; we rebuild the exact query string from those keys
 * (sorted), HMAC-SHA256 it with the Payment API key, and compare in constant
 * time against the `x-kashier-signature` header.
 */
function kashierVerifyWebhook(data, headerSig, key) {
  try {
    if (!data || !Array.isArray(data.signatureKeys) || !headerSig) return false;
    const qs = require('querystring');
    const crypto = require('crypto');
    const keys = data.signatureKeys.slice().sort();
    const obj = {};
    keys.forEach(k => { obj[k] = data[k]; });
    const payload = qs.stringify(obj);
    const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(headerSig), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    console.error('[kashier] signature verify threw:', e.message);
    return false;
  }
}

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

// Strip HTML → readable plaintext for the multipart text/plain alt.
// Mail-Tester deducted -0.6 specifically for the missing plain part
// (lifted welcome-email score from 9.4 → 10).
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/(h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendEmail({ to, subject, body }) {
  const resendKey   = process.env.RESEND_KEY;
  const sendgridKey = process.env.SENDGRID_KEY;

  if (!resendKey && !sendgridKey) {
    console.warn(`[sendEmail] No email provider configured — skipping email to ${to}. Set RESEND_KEY or SENDGRID_KEY.`);
    return { ok: false, reason: 'no-provider' };
  }

  // Standard transactional-email headers buyers' inbox providers (Gmail,
  // Outlook, Yahoo) reward with higher inbox placement:
  //   • List-Unsubscribe + List-Unsubscribe-Post → required for bulk by Gmail 2024.
  //   • Auto-Submitted: auto-generated → tells mail clients it's transactional.
  const COMMON_HEADERS = {
    'List-Unsubscribe':       `<mailto:unsubscribe@digitalmarketstore.shop?subject=unsubscribe>, <https://digitalmarketstore.shop/?unsub=1>`,
    'List-Unsubscribe-Post':  'List-Unsubscribe=One-Click',
    'Auto-Submitted':         'auto-generated',
    'X-Entity-Ref-ID':        require('crypto').randomUUID()
  };

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
          html: body,
          text: htmlToText(body),   // multipart alt — +0.6 SpamAssassin
          headers: COMMON_HEADERS
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
          personalizations: [{
            to: [{ email: to }],
            subject,
            headers: COMMON_HEADERS
          }],
          from: { email: FROM_EMAIL, name: FROM_NAME },
          reply_to: { email: REPLY_TO },
          // Order matters: SendGrid uses LAST content type as the preferred one,
          // and RFC 1341 says text/plain MUST come first in multipart/alternative.
          content: [
            { type: 'text/plain', value: htmlToText(body) },
            { type: 'text/html',  value: body }
          ]
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

      // Seller notifications — one email per unique seller whose product
      // is in this order. Skips items with sellerId='admin' (the admin
      // already got their notification above). Replaces the legacy SPA-
      // side EmailJS seller_new_order call, which used a template that
      // confusingly said "Your payment has been confirmed and your
      // download is ready" — wrong recipient + wrong wording.
      try {
        const sellerIds = [...new Set(
          (after.items || []).map(i => i.sellerId).filter(s => s && s !== 'admin')
        )];
        for (const sid of sellerIds) {
          try {
            const sellerSnap = await db.collection('users').doc(sid).get();
            if (!sellerSnap.exists) continue;
            const sd = sellerSnap.data();
            if (!sd.email) continue;
            const sellerItems = (after.items || []).filter(i => i.sellerId === sid);
            const sellerTotal = sellerItems.reduce((s, i) => s + Number(i.price || 0), 0);
            await sendEmail({
              to: sd.email,
              subject: `[Seller] New order EGP ${sellerTotal} — ${sellerItems.map(i => i.name).join(', ').slice(0, 60)}`,
              body: `<p>Hi ${sd.shopName || sd.name || 'there'},</p>
                     <p>Good news — a buyer just placed an order that includes one of your products. We will process the payment and once approved you'll see the sale in your seller dashboard.</p>
                     <p><strong>Items:</strong> ${sellerItems.map(i => i.name).join(', ')}<br>
                        <strong>Your earnings (this order):</strong> EGP ${sellerTotal}<br>
                        <strong>Buyer:</strong> ${buyerName}<br>
                        <strong>Order ID:</strong> #${orderShort}</p>
                     <p><a href="https://digitalmarketstore.shop/#seller">Open seller dashboard →</a></p>
                     <p>— The DigitalMarket Team</p>`
            });
          } catch (e) {
            console.warn(`[onOrderStatusChange:created] seller email failed for ${sid}:`, e.message);
          }
        }
      } catch (e) {
        console.warn(`[onOrderStatusChange:created] seller-loop failed for ${orderId}:`, e.message);
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

      // PURCHASE MARKERS — deterministic /purchases/{uid_productId} docs that
      // firestore.rules' hasPurchased() checks for review eligibility. Orders
      // use auto-IDs, so without these markers no buyer could ever pass the
      // verified-purchase rule and every review was rejected.
      try {
        const pbatch = db.batch();
        for (const item of (after.items || [])) {
          if (!item.id || !after.buyerId) continue;
          pbatch.set(db.collection('purchases').doc(`${after.buyerId}_${item.id}`), {
            buyerId: after.buyerId,
            productId: item.id,
            orderId,
            createdAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
        await pbatch.commit();
      } catch (e) {
        console.warn(`[onOrderStatusChange] purchase markers failed for ${orderId}:`, e.message);
      }

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
      const orderShort = orderId.slice(0,8).toUpperCase();
      if (buyerEmail) {
        await sendEmail({
          to:      buyerEmail,
          subject: '↩ Refund processed – DigitalMarket',
          body:    `<p>Your refund for order #${orderShort} has been processed. Funds will appear within 5–10 business days.</p>
                    <p>Your access to the downloaded files for this order has been removed.</p>`
        });
      }

      // Add notification for buyer
      if (after.buyerId) {
        await db.collection('notifications').add({
          userId:    after.buyerId,
          type:      'refund',
          message:   `Refund for order #${orderShort} has been processed.`,
          orderId,
          read:      false,
          createdAt: FieldValue.serverTimestamp()
        });
      }

      // ── Seller-side reversal — guarded so a pending⇄refunded toggle or a
      //    double webhook can't double-decrement. Only runs once. ──
      if (!after.refundProcessedAt) {
        // 1) Revoke the buyer's download access (a refunded buyer must NOT
        //    keep the product). Expire the token + flag the order.
        try {
          await event.data.after.ref.update({
            downloadExpired: true,
            downloadToken: FieldValue.delete(),
            licenseKeys: FieldValue.delete(),   // revoke license keys too
            refundRequested: false,             // clear the "Refund Pending" flag
            refundProcessedAt: FieldValue.serverTimestamp()
          });
        } catch (e) {
          console.warn(`[refund] could not revoke downloads for ${orderId}:`, e.message);
        }

        // 2) Reverse the seller's sale count + recompute tier (mirror of the
        //    approval-time logic), and notify each seller in-app.
        const TIERS = [[200,'Platinum'],[50,'Gold'],[10,'Silver'],[0,'Bronze']];
        for (const sid of (after.sellerIds || [])) {
          if (!sid || sid === 'admin') continue;
          try {
            const sellerRef = db.collection('users').doc(sid);
            await db.runTransaction(async tx => {
              const snap     = await tx.get(sellerRef);
              const newCount = Math.max(0, (snap.data()?.totalSales || 0) - 1);
              const tier     = (TIERS.find(([min]) => newCount >= min) || TIERS[3])[1];
              tx.update(sellerRef, { totalSales: newCount, tier });
            });
            await db.collection('notifications').add({
              userId:    sid,
              type:      'refund',
              message:   `Order #${orderShort} was refunded — the sale has been reversed.`,
              orderId,
              read:      false,
              createdAt: FieldValue.serverTimestamp()
            });
          } catch (e) {
            console.warn(`[refund] seller reversal failed for ${sid}:`, e.message);
          }
        }
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

// ─── reviewRequestEmails — nudge buyers to leave an HONEST review 2–21 days
// after delivery. Builds real social proof on autopilot; fires once per order
// (reviewRequestSent flag). No fabricated reviews — just an invitation.
exports.reviewRequestEmails = onSchedule(
  { schedule: 'every day 11:00', region: 'us-central1', timeZone: 'Africa/Cairo', secrets: EMAIL_SECRETS },
  async () => {
    const now = Date.now();
    const MIN_AGE = 2  * 24 * 60 * 60 * 1000;   // wait ≥2 days so they've used it
    const MAX_AGE = 21 * 24 * 60 * 60 * 1000;   // don't pester old orders
    const snap = await db.collection('orders').where('status', '==', 'approved').limit(300).get();
    let sent = 0;
    for (const doc of snap.docs) {
      const o = doc.data();
      if (o.reviewRequestSent) continue;
      if (!o.buyerEmail) continue;
      const ts = (o.approvedAt && o.approvedAt.toMillis && o.approvedAt.toMillis())
              || (o.updatedAt && o.updatedAt.toMillis && o.updatedAt.toMillis())
              || (o.createdAt && o.createdAt.toMillis && o.createdAt.toMillis()) || 0;
      const age = now - ts;
      if (age < MIN_AGE || age > MAX_AGE) continue;
      const items = o.items || [];
      const first = items[0] || {};
      const link  = `https://digitalmarketstore.shop/?p=${encodeURIComponent(first.id || '')}&utm_source=review_request`;
      const names = items.map(i => i.name).filter(Boolean).slice(0, 3).join(', ') || 'your purchase';
      const firstName = o.buyerName ? String(o.buyerName).split(' ')[0] : 'there';
      const result = await sendEmail({
        to: o.buyerEmail,
        subject: '⭐ How was your purchase? (30 seconds)',
        body: `<p>Hi ${firstName},</p>
               <p>Thanks for buying <strong>${names}</strong> from DigitalMarket!</p>
               <p>If it helped you, a quick honest review would mean a lot — it helps other buyers decide and supports the store.</p>
               <p><a href="${link}">Leave a review →</a></p>
               <p>And if anything wasn't perfect, just reply to this email and we'll make it right.</p>
               <p>— The DigitalMarket team</p>`
      }).catch(e => ({ ok: false, err: String(e?.message || e) }));
      if (result && result.ok) {
        sent++;
        await doc.ref.update({ reviewRequestSent: true, reviewRequestAt: FieldValue.serverTimestamp() });
      }
    }
    console.log(`[reviewRequestEmails] Sent ${sent} review request(s).`);
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

    // Mark the order as DOWNLOADED (consumed). Refund policy: digital products
    // are non-refundable once downloaded, so this flag gates refund eligibility.
    // Server-side + awaited so a buyer cannot avoid it to stay refund-eligible.
    // (A no-status-change write — onOrderStatusChange returns early on it.)
    try {
      await db.collection('orders').doc(orderId).set({
        downloaded: true,
        downloadedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.warn('[downloadFile] downloaded-flag write failed:', e.message);
    }

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
//   # CRITICAL: the bucket MUST be in the SAME location as the Firestore
//   # database. This project's DB is the EU multi-region (eur3), so the
//   # bucket must be europe-west1 (or the `eu` multi-region). A us-* bucket
//   # fails with `3 INVALID_ARGUMENT: ... can only operate on buckets
//   # spanning location eu...`.
//   gcloud storage buckets create gs://digitalmarket-38db5-backups \
//     --location=europe-west1 --uniform-bucket-level-access
//   # IMPORTANT: gen-2 functions run as the COMPUTE default SA, NOT the
//   # App Engine default SA. Grant the export role to the compute SA or
//   # the call fails with `7 PERMISSION_DENIED`.
//   gcloud projects add-iam-policy-binding digitalmarket-38db5 \
//     --member="serviceAccount:825210967355-compute@developer.gserviceaccount.com" \
//     --role="roles/datastore.importExportAdmin"
//   gsutil lifecycle set <(echo '{"rule":[{"action":{"type":"Delete"},
//     "condition":{"age":30}}]}') gs://digitalmarket-38db5-backups

const firestoreAdminClient =
  new (require('@google-cloud/firestore').v1.FirestoreAdminClient)();

// ─── 12. onProductStatusAudit ─────────────────────────────────────────
// Forensic audit log for every change to a product's `status`. Writes a
// row to `productStatusAudit/{autoId}` with before/after + uid + when.
// If a previously-approved product is downgraded (approved → anything),
// also logs an ERROR to Cloud Logging so an alert policy can page you.
//
// This is the safety net we wished we had when 8 products silently
// flipped on 2026-05-24. Now every status change is forensically
// reconstructable.

// ─── onNewsletterSignup ────────────────────────────────────────────
// Fires when a visitor submits the newsletter form. Sends an immediate
// welcome email so subscribers see proof their click did something,
// AND so any deliverability problem (Resend key, DNS, SPF/DKIM) is
// discovered the instant a new subscriber signs up — not weeks later
// when the first campaign goes out.
//
// Idempotent: re-subscribing won't double-send because /newsletter is
// keyed by auto-id and the function only runs on create.

const { onDocumentCreated } = require('firebase-functions/v2/firestore');

exports.onNewsletterSignup = onDocumentCreated(
  { document: 'newsletter/{subId}', region: 'us-central1', secrets: EMAIL_SECRETS },
  async (event) => {
    const data = event.data?.data();
    if (!data?.email) return;

    const subject = '👋 Welcome to DigitalMarket — your first deal inside';
    const body = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;">
        <h1 style="font-size:22px;margin:0 0 12px;">Welcome aboard 👋</h1>
        <p style="font-size:15px;line-height:1.55;color:#444;margin:0 0 16px;">
          Thanks for subscribing to DigitalMarket. You'll be the first to hear about new releases, flash sales, and exclusive deals from our top creators.
        </p>
        <p style="font-size:15px;line-height:1.55;color:#444;margin:0 0 20px;">
          As a thank-you, here's <strong>10% off your first order</strong> with code:
        </p>
        <div style="background:#f5f3ff;border:1px solid #c4b5fd;border-radius:10px;padding:14px 18px;text-align:center;font-family:ui-monospace,monospace;font-size:18px;font-weight:700;letter-spacing:0.08em;color:#5b21b6;margin:0 0 24px;">
          WELCOME10
        </div>
        <a href="https://digitalmarketstore.shop"
           style="display:inline-block;background:#6366f1;color:#fff;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:10px;">
          Browse Products →
        </a>
        <p style="font-size:12px;color:#888;margin-top:32px;line-height:1.5;">
          You're getting this because you subscribed at digitalmarketstore.shop.<br>
          Reply to this email to unsubscribe — we read every message.
        </p>
      </div>`;

    try {
      const r = await sendEmail({ to: data.email, subject, body });
      // Persist outcome so admin can see at a glance whether the welcome
      // pipeline is healthy.
      await event.data.ref.update({
        welcomeSent:  !!r?.ok,
        welcomeAt:    FieldValue.serverTimestamp(),
        welcomeError: r?.ok ? null : (r?.reason || `status:${r?.status}` || 'unknown')
      }).catch(() => {});
      if (!r?.ok) {
        await db.collection('emailFailures').add({
          type: 'newsletter_welcome',
          toHash: hashEmail(data.email),
          reason: r?.reason || `status:${r?.status}` || 'unknown',
          createdAt: FieldValue.serverTimestamp()
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[onNewsletterSignup] failed:', e.message);
    }
  }
);

// ─── healthCheck ───────────────────────────────────────────────────
// Plain GET endpoint that returns 200 + JSON. UptimeRobot, BetterStack,
// Pingdom, etc. can hit this — onCall callables are POST-only and
// return 404 on GET, which is why the previous /generateSitemap
// monitor was permanently red. Cheap (no Firestore reads).

exports.healthCheck = onRequest(
  { region: 'us-central1', cors: true, invoker: 'public' },
  (req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.status(200).json({
      ok: true,
      service: 'digitalmarket',
      timestamp: new Date().toISOString(),
      uptime_s: Math.round(process.uptime())
    });
  }
);

exports.onProductStatusAudit = onDocumentWritten(
  { document: 'products/{productId}', region: 'us-central1' },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    const productId = event.params.productId;

    // Skip creates (no before) — status starts at pending/draft naturally.
    if (!before) return;
    // Skip deletes.
    if (!after) return;
    // Skip writes that didn't touch status.
    if (before.status === after.status) return;

    const entry = {
      productId,
      productName: after.name || before.name || '(unknown)',
      sellerId:    after.sellerId || before.sellerId || null,
      statusBefore: before.status || null,
      statusAfter:  after.status  || null,
      // event.authContext is available on 2nd-gen triggers for client SDK writes.
      changedByUid: event.authContext?.authId || null,
      changedAt:    FieldValue.serverTimestamp()
    };
    try {
      await db.collection('productStatusAudit').add(entry);
    } catch (e) {
      console.error('[onProductStatusAudit] write failed:', e.message);
    }

    // Loud alarm if approval is REMOVED. This is the case worth paging on.
    if (before.status === 'approved' && after.status !== 'approved') {
      console.error('[onProductStatusAudit] DOWNGRADE',
        JSON.stringify({ productId, name: entry.productName,
                         from: 'approved', to: entry.statusAfter,
                         by: entry.changedByUid }));
    } else {
      console.log('[onProductStatusAudit]',
        `${productId} ${entry.statusBefore} → ${entry.statusAfter} (by ${entry.changedByUid || 'system'})`);
    }
  }
);

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

// ═══════════════════════════════════════════════════════════════════
// KASHIER PAYMENTS
//
//  createKashierPayment (callable) — builds a SIGNED hosted-payment-page URL
//    for an order the caller owns. The amount is taken from the order doc in
//    Firestore (NEVER trusted from the client) and the hash is computed here
//    with the server-only Payment API key, so a buyer can't tamper with price.
//
//  kashierWebhook (HTTPS) — Kashier's server calls this after a payment. We
//    verify the x-kashier-signature, re-check the amount against the order,
//    then flip the order to 'approved' — which fires onOrderStatusChange and
//    issues the download links + license keys exactly like a manual approval.
//    A 'refund' event flips the order to 'refunded' (reuses that branch too).
// ═══════════════════════════════════════════════════════════════════

exports.createKashierPayment = onCall(
  { region: 'us-central1', secrets: KASHIER_FULL_SECRETS },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Please sign in to pay.');

    const orderId = String(request.data?.orderId || '').trim();
    if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required.');

    const mid       = KASHIER_MID.value();
    const apiKey    = KASHIER_PAYMENT_KEY.value();   // → api-key header
    const secretKey = KASHIER_SECRET_KEY.value();    // → Authorization header
    if (!mid || !apiKey || !secretKey) {
      console.error('[kashier] keys not fully configured');
      throw new HttpsError('failed-precondition', 'Card payments are not configured yet.');
    }

    const ref  = db.collection('orders').doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Order not found.');
    const order = snap.data();

    // Ownership + state guards — only the buyer can pay, and only an order
    // that is still awaiting payment (idempotent: don't re-charge a paid one).
    if (order.buyerId !== uid) throw new HttpsError('permission-denied', 'Not your order.');
    if (order.status === 'approved') throw new HttpsError('failed-precondition', 'Order already paid.');
    if (!['awaiting_payment', 'pending'].includes(order.status)) {
      throw new HttpsError('failed-precondition', `Order is ${order.status}; cannot pay.`);
    }

    const total = Number(order.total || 0);
    if (!(total > 0)) throw new HttpsError('failed-precondition', 'Order total must be greater than zero.');

    const amount   = total.toFixed(2);   // Sessions require amount as a STRING
    const currency = 'EGP';              // store base currency
    const serverWebhook    = `https://us-central1-${process.env.GCLOUD_PROJECT || 'digitalmarket-38db5'}.cloudfunctions.net/kashierWebhook`;
    const merchantRedirect = `${SITE_ORIGIN}/?kashier=return&order=${encodeURIComponent(orderId)}`;

    // ── Create a Payment Session (server-side). The hash is computed by
    // Kashier and returned inside the session — it never touches the browser
    // (more secure than the old query-string Hosted-Payment-Page method). ──
    const sessionBody = {
      amount,                       // STRING
      currency,
      order: orderId,               // our merchant order id
      merchantId: mid,
      merchantRedirect,             // browser bounce-back (success AND failure)
      failureRedirect: true,        // BOOLEAN — also bounce back on failure
      serverWebhook,                // signed server-to-server fulfillment
      allowedMethods: 'card',       // STRING
      enable3DS: true,
      brandColor: KASHIER_BRAND_COLOR,
      type: 'one-time',
      paymentType: 'one-time',
      customer: {                   // REQUIRED by the Sessions API
        email: order.buyerEmail || request.auth.token?.email || 'buyer@digitalmarketstore.shop',
        reference: uid
      }
    };

    let kres, kjson;
    try {
      kres = await fetch(`${KASHIER_API_BASE}/v3/payment/sessions`, {
        method: 'POST',
        headers: {
          'Authorization': secretKey,
          'api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sessionBody)
      });
      kjson = await kres.json().catch(() => ({}));
    } catch (e) {
      console.error('[kashier] session create network error:', e.message);
      throw new HttpsError('unavailable', 'Could not reach the payment provider. Please try again.');
    }

    const paymentUrl = kjson?.sessionUrl;
    if (!kres.ok || !paymentUrl) {
      console.error('[kashier] session create failed', { orderId, status: kres.status, msg: kjson?.message });
      throw new HttpsError('aborted', 'Could not start the payment. Please try again.');
    }

    // Mark the order as awaiting payment + write an audit row in /payments.
    await ref.set({
      paymentMethod: 'kashier',
      paymentStatus: 'initiated',
      kashierSessionId: kjson._id || null,
      status: order.status === 'pending' ? 'awaiting_payment' : order.status,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('payments').doc(orderId).set({
      orderId, buyerId: uid, provider: 'kashier', mode: KASHIER_MODE,
      amount: total, currency, status: 'initiated', sessionId: kjson._id || null,
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[kashier] session created order=${orderId} amount=${amount} ${currency} mode=${KASHIER_MODE} session=${kjson._id}`);
    return { paymentUrl };
  }
);

exports.kashierWebhook = onRequest(
  { region: 'us-central1', secrets: KASHIER_SECRETS, cors: false },
  async (req, res) => {
    // Always 200 on benign cases so Kashier doesn't endlessly retry; only
    // 401 on a bad signature (that's a real security signal worth surfacing).
    try {
      if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

      const key = KASHIER_PAYMENT_KEY.value();
      const body = req.body || {};
      const data = body.data || {};
      const event = body.event || data.event || '';
      const headerSig = req.get('x-kashier-signature') || req.get('X-Kashier-Signature');

      if (!kashierVerifyWebhook(data, headerSig, key)) {
        console.error('[kashier] webhook signature INVALID', { event, order: data.merchantOrderId });
        res.status(401).send('invalid signature');
        return;
      }

      // Order id field name varies between HPP + Payment Sessions payloads.
      const orderId = String(data.merchantOrderId || data.order || data.orderReference || '').trim();
      const status  = String(data.status || '').toUpperCase();
      if (!orderId) { res.status(200).send('no order'); return; }

      const ref  = db.collection('orders').doc(orderId);
      const snap = await ref.get();
      if (!snap.exists) {
        console.warn('[kashier] webhook for unknown order', orderId);
        res.status(200).send('unknown order');
        return;
      }
      const order = snap.data();

      // ── Refund event → flip to refunded (reuses onOrderStatusChange) ──
      if (event === 'refund' && status === 'SUCCESS') {
        if (order.status !== 'refunded') {
          await ref.set({ status: 'refunded', paymentStatus: 'refunded',
            kashierTransactionId: data.transactionId || null,
            updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          await db.collection('payments').doc(orderId).set({
            status: 'refunded', refundedAt: FieldValue.serverTimestamp() }, { merge: true });
          console.log('[kashier] order refunded', orderId);
        }
        res.status(200).send('ok'); return;
      }

      // ── Payment success → approve (idempotent + anti-tamper) ──
      if ((event === 'pay' || event === 'capture') && status === 'SUCCESS') {
        if (order.status === 'approved') { res.status(200).send('already approved'); return; }

        const paidAmount  = Number(data.amount || 0).toFixed(2);
        const orderAmount = Number(order.total || 0).toFixed(2);
        const paidCur     = String(data.currency || '').toUpperCase();
        if (paidAmount !== orderAmount || (paidCur && paidCur !== 'EGP')) {
          console.error('[kashier] AMOUNT/CURRENCY MISMATCH — not approving', {
            orderId, paidAmount, orderAmount, paidCur });
          await ref.set({ paymentStatus: 'amount_mismatch',
            updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          res.status(200).send('amount mismatch'); return;
        }

        await ref.set({
          status: 'approved',                 // ← triggers download issuance
          paymentStatus: 'paid',
          paymentMethod: 'kashier',
          kashierTransactionId: data.transactionId || null,
          kashierOrderId: data.kashierOrderId || null,
          paidAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        await db.collection('payments').doc(orderId).set({
          status: 'paid', transactionId: data.transactionId || null,
          method: data.method || 'card', paidAt: FieldValue.serverTimestamp()
        }, { merge: true });

        console.log('[kashier] order APPROVED via card', orderId);
        res.status(200).send('ok'); return;
      }

      // Any other event/status — acknowledge, record, take no action.
      await db.collection('payments').doc(orderId).set({
        lastEvent: event, lastStatus: status, updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      res.status(200).send('ack');
    } catch (e) {
      console.error('[kashier] webhook handler error:', e);
      res.status(200).send('error-logged'); // 200 so Kashier won't hammer retries
    }
  }
);

// ── kashierRefund (callable, ADMIN) ──────────────────────────────────
// Actually moves money back via Kashier's Refund API, then (for a FULL
// refund) flips the order to 'refunded' — which fires the refund branch in
// onOrderStatusChange (revokes downloads, reverses the seller sale, emails +
// notifies buyer & seller). Partial refunds keep the order 'approved' but
// record the partial amount.
exports.kashierRefund = onCall(
  { region: 'us-central1', secrets: KASHIER_FULL_SECRETS },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const adminSnap = await db.collection('users').doc(uid).get();
    if (adminSnap.data()?.role !== 'admin') throw new HttpsError('permission-denied', 'Admin only.');

    // Refunds authorize with the SECRET key (not the Payment key).
    const key = KASHIER_SECRET_KEY.value();
    if (!key) throw new HttpsError('failed-precondition', 'Kashier refund key (KASHIER_SECRET_KEY) is not configured.');

    const orderId = String(request.data?.orderId || '').trim();
    const reason  = String(request.data?.reason || 'Customer refund').slice(0, 200);
    if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required.');

    const ref  = db.collection('orders').doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Order not found.');
    const order = snap.data();

    if (order.paymentMethod !== 'kashier') {
      throw new HttpsError('failed-precondition', 'Only card (Kashier) orders can be refunded here. Refund InstaPay/bank orders manually.');
    }
    if (order.status === 'refunded') throw new HttpsError('failed-precondition', 'Order already refunded.');
    if (order.status !== 'approved')  throw new HttpsError('failed-precondition', `Order is ${order.status}; only paid orders can be refunded.`);
    const kashierOrderId = order.kashierOrderId;
    if (!kashierOrderId) throw new HttpsError('failed-precondition', 'Missing Kashier order reference; cannot refund automatically.');

    const orderTotal = Number(order.total || 0);
    let amount = (request.data?.amount != null) ? Number(request.data.amount) : orderTotal;
    if (!(amount > 0) || amount > orderTotal) {
      throw new HttpsError('invalid-argument', `Refund amount must be between 0 and ${orderTotal}.`);
    }
    amount = Math.round(amount * 100) / 100;
    const isFull = amount >= orderTotal;

    // Call Kashier's Refund API. The endpoint is /v3/orders/:orderId (the
    // missing /v3/ was why Kashier's backend errored with "getaddrinfo
    // undefined"). orderId is the Kashier Order ID; no query params needed.
    const url = `${KASHIER_FEP_BASE}/v3/orders/${encodeURIComponent(kashierOrderId)}`;
    console.log('[kashierRefund] calling', url, '| txn:', order.kashierTransactionId || '(none)', '| amount:', amount);
    let kres, kjson;
    try {
      kres = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': key,
          'accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ apiOperation: 'REFUND', reason, transaction: { amount } })
      });
      kjson = await kres.json().catch(() => ({}));
    } catch (e) {
      console.error('[kashierRefund] network error:', e.message);
      throw new HttpsError('unavailable', 'Could not reach Kashier. Please try again.');
    }

    // Kashier returns top-level status SUCCESS (done) or PENDING (initiated,
    // will settle) on acceptance; FAILURE means rejected. Treat SUCCESS +
    // PENDING as accepted.
    const kStatus = String(kjson?.status || kjson?.response?.status || '').toUpperCase();
    const ok = kres.ok && (kStatus === 'SUCCESS' || kStatus === 'PENDING');
    if (!ok) {
      console.error('[kashierRefund] refund rejected', { orderId, status: kres.status, body: kjson });
      const msg = kjson?.messages?.en || kjson?.message || `Kashier refund failed (HTTP ${kres.status}).`;
      throw new HttpsError('aborted', msg);
    }

    // Record + update order. FULL refund → flip to 'refunded' (fires the
    // refund branch). Partial → annotate but keep the order approved.
    await db.collection('payments').doc(orderId).set({
      refundAmount: amount, refundReason: reason, refundBy: uid,
      refundStatus: isFull ? 'full' : 'partial',
      refundedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    if (isFull) {
      await ref.set({
        status: 'refunded',
        paymentStatus: 'refunded',
        refundAmount: amount,
        refundReason: reason,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      await ref.set({
        paymentStatus: 'partially_refunded',
        refundAmount: FieldValue.increment(amount),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    console.log(`[kashierRefund] ${isFull ? 'FULL' : 'PARTIAL'} refund ${amount} EGP order=${orderId} by admin ${uid.slice(0,8)}`);
    return { ok: true, refundAmount: amount, full: isFull };
  }
);

// ─────────────────────────────────────────────────────────────────────
// kashierPayout — ADMIN-ONLY automated seller disbursement (Kashier Payout
// /v3/transfers/single). Pays a seller their NET owed (price × (1−commission))
// out of the platform's Kashier balance. The platform commission simply never
// leaves the balance. A payout doc is written FIRST (status 'processing') for
// idempotency; the kashierPayoutWebhook flips it to 'paid' on TRANSFERRED.
// Runs in KASHIER_PAYOUT_MODE (test by default) — independent of payments.
// ─────────────────────────────────────────────────────────────────────
exports.kashierPayout = onCall(
  { region: 'us-central1', secrets: KASHIER_FULL_SECRETS },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const adminSnap = await db.collection('users').doc(uid).get();
    if (adminSnap.data()?.role !== 'admin') throw new HttpsError('permission-denied', 'Admin only.');

    const key = KASHIER_SECRET_KEY.value();
    if (!key) throw new HttpsError('failed-precondition', 'Kashier secret key (KASHIER_SECRET_KEY) is not configured.');

    const sellerId = String(request.data?.sellerId || '').trim();
    if (!sellerId) throw new HttpsError('invalid-argument', 'sellerId is required.');

    // Platform commission rate (settings/payment.commission, default 5%).
    let platformRate = 5;
    try {
      const sd = await db.collection('settings').doc('payment').get();
      const r = Number(sd.exists ? sd.data().commission : 5);
      if (!isNaN(r) && r >= 0 && r <= 100) platformRate = r;
    } catch {}

    // Compute net owed server-side (never trust a client amount blindly).
    const [ordSnap, paySnap] = await Promise.all([
      db.collection('orders').where('sellerIds', 'array-contains', sellerId).where('status', '==', 'approved').get(),
      db.collection('payouts').where('sellerId', '==', sellerId).get()
    ]);
    let netEarned = 0;
    ordSnap.docs.forEach(d => {
      const o = d.data();
      const r = Number(o.commissionRate != null ? o.commissionRate : platformRate);
      (o.items || []).forEach(it => {
        if ((it.sellerId || 'admin') === sellerId) netEarned += Number(it.price || 0) * (1 - r / 100);
      });
    });
    // Count 'paid' AND in-flight 'processing' payouts as already-committed → no double-pay.
    const committed = paySnap.docs
      .filter(d => ['paid', 'processing'].includes(d.data().status))
      .reduce((s, d) => s + Number(d.data().amount || 0), 0);
    const owed = Math.round((netEarned - committed) * 100) / 100;

    let amount = (request.data?.amount != null) ? Number(request.data.amount) : owed;
    amount = Math.round(amount * 100) / 100;
    if (!(amount > 0)) throw new HttpsError('failed-precondition', `Nothing owed to this seller (owed: ${owed}).`);
    if (amount > owed) throw new HttpsError('invalid-argument', `Amount ${amount} exceeds owed balance ${owed}.`);
    if (amount < 100) throw new HttpsError('failed-precondition', 'Minimum payout is EGP 100.');

    // Resolve the seller's payout destination.
    const seller = (await db.collection('users').doc(sellerId).get()).data() || {};
    const method = (seller.payoutMethod || (seller.accountNum && seller.payoutBank ? 'bank' : 'wallet')).toLowerCase();
    const recipientNumber = String(seller.payoutNumber || seller.phone || seller.instapay || seller.accountNum || '').trim();
    const recipientName = String(seller.accountHolder || seller.shopName || seller.name || 'Seller').slice(0, 80);
    const recipientBank = method === 'bank' ? (seller.payoutBank || seller.bank || '') : undefined;
    if (!recipientNumber) {
      throw new HttpsError('failed-precondition', 'Seller has no payout destination. Ask them to add a wallet/phone or bank account in their Settings.');
    }
    if (method === 'bank' && !recipientBank) {
      throw new HttpsError('failed-precondition', 'Bank payout needs a recognized Kashier bank code (payoutBank). Use a wallet payout or set the bank code.');
    }

    const merchantTransferId = `po_${sellerId.slice(0, 12)}_${Date.now()}`;
    // Write the payout doc FIRST (idempotency + webhook can find it).
    const payoutRef = await db.collection('payouts').add({
      sellerId,
      sellerName: seller.shopName || seller.name || '',
      sellerEmail: seller.email || '',
      amount,
      method,
      recipientNumber,
      recipientName,
      via: 'kashier',
      merchantTransferId,
      status: 'processing',
      mode: KASHIER_PAYOUT_MODE,
      initiatedBy: uid,
      requestedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp()
    });

    const body = { amount, method, recipientName, recipientNumber, merchantTransferId };
    if (recipientBank) body.recipientBank = recipientBank;

    const url = `${KASHIER_PAYOUT_BASE}/v3/transfers/single`;
    console.log('[kashierPayout]', KASHIER_PAYOUT_MODE, 'transfer', amount, 'EGP →', method, recipientNumber.slice(0, 4) + '***', 'mtid:', merchantTransferId);
    let kres, kjson;
    try {
      kres = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': key, 'accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      kjson = await kres.json().catch(() => ({}));
    } catch (e) {
      await payoutRef.set({ status: 'failed', failReason: 'network: ' + e.message, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw new HttpsError('unavailable', 'Could not reach Kashier payout service: ' + e.message);
    }

    const tStatus = String(kjson.status || kjson.transferStatus || '').toUpperCase();
    const ok = kres.ok && (tStatus === 'INITIATED' || tStatus === 'IN_TRANSIT' || tStatus === 'TRANSFERRED' || tStatus === 'PENDING');
    if (!ok) {
      const reason = kjson.message || kjson.transferResponseMessage || `HTTP ${kres.status}`;
      await payoutRef.set({ status: 'failed', failReason: String(reason).slice(0, 300), kashierResponse: tStatus || null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      console.error('[kashierPayout] FAILED', kres.status, reason);
      throw new HttpsError('internal', 'Kashier payout failed: ' + reason);
    }

    const settled = tStatus === 'TRANSFERRED';
    await payoutRef.set({
      transferId: kjson.transferId || null,
      transferStatus: tStatus,
      status: settled ? 'paid' : 'processing',
      ...(settled ? { paidAt: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[kashierPayout] ${tStatus} ${amount} EGP seller=${sellerId.slice(0, 8)} transferId=${kjson.transferId || '-'}`);
    return { ok: true, transferId: kjson.transferId || null, status: settled ? 'paid' : 'processing', transferStatus: tStatus, amount, mode: KASHIER_PAYOUT_MODE };
  }
);

// ─── kashierPayoutWebhook — confirms transfer final status (TRANSFERRED/FAILED).
// Signed with the Payment API key (same HMAC-SHA256 scheme as kashierWebhook).
// Matches the payout by merchantTransferId and flips its status.
exports.kashierPayoutWebhook = onRequest(
  { region: 'us-central1', secrets: KASHIER_SECRETS, cors: false },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
      const key = KASHIER_PAYMENT_KEY.value();
      const body = req.body || {};
      const data = body.data || body || {};
      const headerSig = req.get('x-kashier-signature') || req.get('X-Kashier-Signature');

      if (!kashierVerifyWebhook(data, headerSig, key)) {
        console.error('[kashierPayout] webhook signature INVALID', { mtid: data.merchantTransferId });
        res.status(401).send('invalid signature');
        return;
      }

      const mtid = String(data.merchantTransferId || '').trim();
      const status = String(data.status || data.transferStatus || '').toUpperCase();
      if (!mtid) { res.status(200).send('no transfer id'); return; }

      const q = await db.collection('payouts').where('merchantTransferId', '==', mtid).limit(1).get();
      if (q.empty) { console.warn('[kashierPayout] webhook for unknown transfer', mtid); res.status(200).send('unknown transfer'); return; }
      const ref = q.docs[0].ref;

      if (status === 'TRANSFERRED') {
        await ref.set({ status: 'paid', transferStatus: status, transferId: data.transferId || null, paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        console.log('[kashierPayout] webhook → PAID', mtid);
      } else if (status === 'FAILED' || status === 'REJECTED') {
        await ref.set({ status: 'failed', transferStatus: status, failReason: String(data.transferResponseMessage || 'Transfer failed').slice(0, 300), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        console.warn('[kashierPayout] webhook → FAILED', mtid);
      } else {
        await ref.set({ transferStatus: status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      res.status(200).send('ok');
    } catch (e) {
      console.error('[kashierPayout] webhook error', e.message);
      res.status(200).send('error-logged');
    }
  }
);

// ─── sendVerifyEmail ─────────────────────────────────────────────────────────
// Branded, bilingual email-verification sender that BYPASSES Firebase's locked
// native templates (EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED — confirmed intended
// behavior by Firebase Support, case 10410264). Admin SDK generates the action
// link, we extract the one-time oobCode and point the button at OUR handler
// page (auth-action.html), then deliver via Resend from our own domain.
// Client calls this instead of firebase.auth().currentUser.sendEmailVerification()
// (with the native call kept as a fallback if this function errors).
exports.sendVerifyEmail = onCall(
  { region: 'us-central1', secrets: EMAIL_SECRETS, cors: ['https://digitalmarketstore.shop'] },
  async req => {
    const uid   = req.auth?.uid;
    const email = req.auth?.token?.email;
    if (!uid || !email) throw new HttpsError('unauthenticated', 'Sign in required.');
    if (req.auth.token.email_verified) {
      return { ok: true, already: true };
    }

    // Throttle: max 1 email per 60s per user (Firestore marker).
    const throttleRef = db.collection('mail_throttle').doc(uid);
    const tSnap = await throttleRef.get();
    const last = tSnap.data()?.verifySentAt?.toMillis?.() || 0;
    if (Date.now() - last < 60000) {
      throw new HttpsError('resource-exhausted', 'Please wait a minute before requesting another email.');
    }

    // Generate the action link, then re-point it at our branded handler.
    const rawLink = await getAuth().generateEmailVerificationLink(email);
    const oob = new URL(rawLink).searchParams.get('oobCode');
    if (!oob) throw new HttpsError('internal', 'Could not generate verification code.');
    const link = `https://digitalmarketstore.shop/auth-action.html?mode=verifyEmail&oobCode=${encodeURIComponent(oob)}`;

    const name = (req.auth.token.name || '').split(' ')[0] || '';
    const html = `
<div style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#0F1222;padding:32px 16px;">
  <div style="max-width:480px;margin:0 auto;background:#181C30;border:1px solid #222741;border-radius:16px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#6366F1,#8B5CF6);padding:22px;text-align:center;">
      <div style="font-size:1.3rem;font-weight:800;color:#fff;">🛍️ DigitalMarket</div>
    </div>
    <div style="padding:28px 24px;color:#EDEEF7;">
      <h2 style="margin:0 0 10px;font-size:1.15rem;">Verify your email${name ? ', ' + name : ''} ✉️</h2>
      <p style="margin:0 0 18px;font-size:0.92rem;color:#9CA3C0;line-height:1.6;">
        Tap the button below to confirm your email address and unlock your DigitalMarket account.
      </p>
      <p style="margin:0 0 22px;font-size:0.92rem;color:#9CA3C0;direction:rtl;text-align:right;line-height:1.8;">
        اضغط على الزر بالأسفل لتأكيد بريدك الإلكتروني وتفعيل حسابك في DigitalMarket.
      </p>
      <div style="text-align:center;margin:26px 0;">
        <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#6366F1,#8B5CF6);color:#fff;text-decoration:none;padding:13px 34px;border-radius:12px;font-weight:700;font-size:0.95rem;">
          Verify my email · تأكيد البريد
        </a>
      </div>
      <p style="margin:0;font-size:0.78rem;color:#6B7390;line-height:1.6;">
        If the button doesn't work, copy this link:<br>
        <a href="${link}" style="color:#8B5CF6;word-break:break-all;">${link}</a><br><br>
        Didn't create an account? You can safely ignore this email.<br>
        <span dir="rtl">لم تنشئ حساباً؟ تجاهل هذه الرسالة بأمان.</span>
      </p>
    </div>
    <div style="padding:14px;text-align:center;border-top:1px solid #222741;font-size:0.75rem;color:#6B7390;">
      © DigitalMarket · <a href="https://digitalmarketstore.shop" style="color:#8B5CF6;text-decoration:none;">digitalmarketstore.shop</a>
    </div>
  </div>
</div>`;

    const sent = await sendEmail({
      to: email,
      subject: 'Verify your email · تأكيد بريدك الإلكتروني — DigitalMarket',
      body: html
    });
    if (!sent.ok) throw new HttpsError('internal', 'Email delivery failed — please try again.');

    await throttleRef.set({ verifySentAt: FieldValue.serverTimestamp() }, { merge: true });
    console.log(`[sendVerifyEmail] sent to uid=${uid}`);
    return { ok: true };
  }
);

// ─── sendResetEmail ──────────────────────────────────────────────────────────
// Branded, bilingual PASSWORD RESET email (same Admin-SDK bypass as
// sendVerifyEmail). Called by LOGGED-OUT users from the forgot-password form,
// so it carries its own abuse protection:
//   - never reveals whether an account exists (always returns ok)
//   - 60s throttle per email + 10/hour per IP (mail_throttle collection)
exports.sendResetEmail = onCall(
  { region: 'us-central1', secrets: EMAIL_SECRETS, cors: ['https://digitalmarketstore.shop'] },
  async req => {
    const email = String(req.data?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      throw new HttpsError('invalid-argument', 'Valid email required.');
    }
    const crypto = require('crypto');
    const emailKey = 'reset_' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
    const ip = req.rawRequest?.ip || req.rawRequest?.headers?.['x-forwarded-for']?.split(',')[0] || 'unknown';
    const ipKey = 'rstip_' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);

    // Per-email: 1/min. Per-IP: 10/hour.
    const now = Date.now();
    const [eSnap, iSnap] = await Promise.all([
      db.collection('mail_throttle').doc(emailKey).get(),
      db.collection('mail_throttle').doc(ipKey).get()
    ]);
    if (now - (eSnap.data()?.sentAt?.toMillis?.() || 0) < 60000) {
      return { ok: true };  // silently absorb rapid repeats
    }
    const hourHits = (iSnap.data()?.hits || []).filter(t => now - t < 3600000);
    if (hourHits.length >= 10) {
      throw new HttpsError('resource-exhausted', 'Too many requests — try again later.');
    }

    // Generate the link; if the account doesn't exist, pretend success
    // (anti-enumeration — same behavior the client already shows).
    let link = null;
    try {
      const rawLink = await getAuth().generatePasswordResetLink(email);
      const oob = new URL(rawLink).searchParams.get('oobCode');
      if (oob) link = `https://digitalmarketstore.shop/auth-action.html?mode=resetPassword&oobCode=${encodeURIComponent(oob)}`;
    } catch (e) {
      console.log(`[sendResetEmail] no-account or generate fail (absorbed): ${e.code || e.message}`);
    }

    if (link) {
      const html = `
<div style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#0F1222;padding:32px 16px;">
  <div style="max-width:480px;margin:0 auto;background:#181C30;border:1px solid #222741;border-radius:16px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#6366F1,#8B5CF6);padding:22px;text-align:center;">
      <div style="font-size:1.3rem;font-weight:800;color:#fff;">🛍️ DigitalMarket</div>
    </div>
    <div style="padding:28px 24px;color:#EDEEF7;">
      <h2 style="margin:0 0 10px;font-size:1.15rem;">Reset your password 🔑</h2>
      <p style="margin:0 0 18px;font-size:0.92rem;color:#9CA3C0;line-height:1.6;">
        We received a request to reset your DigitalMarket password. Tap the button to choose a new one. This link can be used once.
      </p>
      <p style="margin:0 0 22px;font-size:0.92rem;color:#9CA3C0;direction:rtl;text-align:right;line-height:1.8;">
        استلمنا طلباً لإعادة تعيين كلمة المرور لحسابك في DigitalMarket. اضغط الزر لاختيار كلمة مرور جديدة. الرابط صالح لمرة واحدة.
      </p>
      <div style="text-align:center;margin:26px 0;">
        <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#6366F1,#8B5CF6);color:#fff;text-decoration:none;padding:13px 34px;border-radius:12px;font-weight:700;font-size:0.95rem;">
          Set new password · تعيين كلمة مرور جديدة
        </a>
      </div>
      <p style="margin:0;font-size:0.78rem;color:#6B7390;line-height:1.6;">
        If the button doesn't work, copy this link:<br>
        <a href="${link}" style="color:#8B5CF6;word-break:break-all;">${link}</a><br><br>
        Didn't request this? Ignore this email — your password stays unchanged.<br>
        <span dir="rtl">لم تطلب إعادة التعيين؟ تجاهل هذه الرسالة — كلمة مرورك لن تتغير.</span>
      </p>
    </div>
    <div style="padding:14px;text-align:center;border-top:1px solid #222741;font-size:0.75rem;color:#6B7390;">
      © DigitalMarket · <a href="https://digitalmarketstore.shop" style="color:#8B5CF6;text-decoration:none;">digitalmarketstore.shop</a>
    </div>
  </div>
</div>`;
      const sent = await sendEmail({
        to: email,
        subject: 'Reset your password · إعادة تعيين كلمة المرور — DigitalMarket',
        body: html
      });
      if (!sent.ok) throw new HttpsError('internal', 'Email delivery failed — please try again.');
    }

    // Record throttle marks regardless of account existence (uniform timing).
    await Promise.all([
      db.collection('mail_throttle').doc(emailKey).set({ sentAt: FieldValue.serverTimestamp() }, { merge: true }),
      db.collection('mail_throttle').doc(ipKey).set({ hits: [...hourHits, now] }, { merge: true })
    ]);
    return { ok: true };
  }
);
