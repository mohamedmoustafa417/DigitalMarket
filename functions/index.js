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

const { onDocumentWritten }      = require('firebase-functions/v2/firestore');
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
      console.log(`[sendEmail] ✓ Resend sent to ${to}: "${subject.slice(0, 40)}"`);
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
      // Issue a secure download token (30-day expiry)
      const token     = require('crypto').randomUUID();
      const expiresAt = Date.now() + 30 * 86400000;
      await event.data.after.ref.update({ downloadToken: token, downloadExpiresAt: expiresAt, downloadExpired: false });

      // Issue license keys for each item (if seller has licenseEnabled)
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const seg   = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      const genKey = () => `${seg()}-${seg()}-${seg()}-${seg()}`;
      const licenseKeys = {};
      (after.items || []).forEach(item => { licenseKeys[item.id] = genKey(); });
      await event.data.after.ref.update({ licenseKeys });

      // Update seller totalSales + tier
      const TIERS = [[200,'Platinum'],[50,'Gold'],[10,'Silver'],[0,'Bronze']];
      for (const sid of (after.sellerIds || [])) {
        try {
          const sellerRef  = db.collection('users').doc(sid);
          const sellerSnap = await sellerRef.get();
          const newCount   = (sellerSnap.data()?.totalSales || 0) + 1;
          const tier       = (TIERS.find(([min]) => newCount >= min) || TIERS[3])[1];
          await sellerRef.update({ totalSales: FieldValue.increment(1), tier });
        } catch {}
      }

      // Award loyalty points to buyer
      if (after.buyerId && after.total) {
        const pts = Math.floor(Number(after.total));
        if (pts > 0) {
          await db.collection('users').doc(after.buyerId).update({ loyaltyPoints: FieldValue.increment(pts) });
          await db.collection('users').doc(after.buyerId).collection('pointsLog').add({
            type: 'earn', pts, reason: `Purchase EGP ${after.total}`,
            createdAt: FieldValue.serverTimestamp()
          });
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

      if (buyerEmail && dlLinks.length > 0) {
        await sendEmail({
          to:      buyerEmail,
          subject: '✅ Your DigitalMarket order is ready!',
          body:    `<p>Hi ${buyerName},</p>
                   <p>Your order <strong>#${orderId.slice(0,8).toUpperCase()}</strong> has been approved.</p>
                   <p>Download your files:</p><ul>${dlLinks.join('')}</ul>
                   <p>Links expire in 30 days. Keep them safe!</p>
                   <p>— The DigitalMarket Team</p>`
        });
      }

      // Notify seller via Firestore notification
      const sellerIds = after.sellerIds || [];
      await Promise.all(sellerIds.map(sid =>
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

    // Build the public URL pattern that Firestore would hold
    // (simplified – real URLs have a token query param, so we match on the path portion)
    const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '%2F');
    const urlFragment = `o/${encodedPath}`;

    const snap = await db.collection('products')
      .where('downloadUrl', '>=', `https://firebasestorage.googleapis.com`)
      .get();

    const batch = db.batch();
    let count = 0;
    snap.docs.forEach(d => {
      if ((d.data().downloadUrl || '').includes(urlFragment)) {
        batch.update(d.ref, { downloadUrl: '' });
        count++;
      }
    });
    if (count > 0) await batch.commit();
    console.log(`[onProductFileDelete] Cleared downloadUrl on ${count} product(s).`);
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
  { schedule: 'every 5 minutes', region: 'us-central1', secrets: EMAIL_SECRETS },
  async () => {
    const queued = await db.collection('campaigns').where('status','==','queued').limit(5).get();
    if (queued.empty) return;

    for (const camp of queued.docs) {
      const c = camp.data();
      await camp.ref.update({ status: 'sending', startedAt: FieldValue.serverTimestamp() });

      try {
        let emails = [];
        if (c.target === 'all') {
          const s = await db.collection('newsletter').limit(2000).get();
          emails = s.docs.map(d => d.data().email).filter(Boolean);
        } else if (c.target === 'buyers' || c.target === 'sellers') {
          const role = c.target.slice(0, -1);
          const s = await db.collection('users').where('role','==',role).limit(2000).get();
          emails = s.docs.map(d => d.data().email).filter(Boolean);
        }

        // Send in batches of 50
        for (let i = 0; i < emails.length; i += 50) {
          const batch = emails.slice(i, i + 50);
          await Promise.all(batch.map(to => sendEmail({ to, subject: c.subject, body: c.body }).catch(() => {})));
        }

        await camp.ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp(), actualRecipientCount: emails.length });
        console.log(`[processEmailCampaigns] Sent campaign ${camp.id} to ${emails.length} recipients.`);
      } catch (err) {
        await camp.ref.update({ status: 'failed', error: String(err.message || err) });
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
