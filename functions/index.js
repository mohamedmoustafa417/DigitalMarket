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
const { onObjectDeleted }        = require('firebase-functions/v2/storage');
const { onSchedule }             = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }     = require('firebase-functions/v2/https');
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

    if (!before || !after) return; // created or deleted – skip
    if (before.status === after.status) return; // no status change

    const orderId = event.params.orderId;

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
        const buyerRef       = db.collection('users').doc(after.buyerId);
        const ptsRedeemed    = Math.max(0, Math.floor(Number(after.pointsRedeemed || 0)));
        const ptsEarned      = Math.max(0, Math.floor(Number(after.total || 0)));
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

      // Fetch fresh download URLs from product docs (more secure than storing in order)
      const dlLinks = (
        await Promise.all(
          items.map(async item => {
            try {
              const snap = await db.collection('products').doc(item.id).get();
              const url  = snap.data()?.downloadUrl || item.downloadUrl || '';
              return url ? `<li><a href="${url}">${item.name}</a></li>` : null;
            } catch { return null; }
          })
        )
      ).filter(Boolean);

      // RELIABILITY: wrap the post-idempotency side effects in try/catch.
      // Previously: if sendEmail threw (Resend 5xx, transient network),
      // the function retried, the idempotency guard short-circuited at
      // the top, and the buyer email was permanently lost. Now: log the
      // failure to /emailFailures so an admin can re-send manually, and
      // let the order finish in a clean state.
      if (buyerEmail && dlLinks.length > 0) {
        try {
          const result = await sendEmail({
            to:      buyerEmail,
            subject: '✅ Your DigitalMarket order is ready!',
            body:    `<p>Hi ${buyerName},</p>
                     <p>Your order <strong>#${orderId.slice(0,8).toUpperCase()}</strong> has been approved.</p>
                     <p>Download your files:</p><ul>${dlLinks.join('')}</ul>
                     <p>Links expire in 30 days. Keep them safe!</p>
                     <p>— The DigitalMarket Team</p>`
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
    if (!filePath || !filePath.startsWith('products/')) return;

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
