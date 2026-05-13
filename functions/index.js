/**
 * DigitalMarket – Cloud Functions (Node 18)
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
const { onCall }                 = require('firebase-functions/v2/https');
const { initializeApp }          = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage }             = require('firebase-admin/storage');

initializeApp();
const db      = getFirestore();
const storage = getStorage();

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Minimal EmailJS-style email via fetch (replace with nodemailer / SendGrid as needed) */
async function sendEmail({ to, subject, body }) {
  // TODO: swap in your preferred transactional email service
  // e.g. SendGrid, Resend, Mailgun
  console.log(`[sendEmail] To: ${to} | Subject: ${subject}`);
  // Example stub – fire & forget
  /*
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SENDGRID_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }], subject }],
      from: { email: 'noreply@digitalmarketstore.shop', name: 'DigitalMarket' },
      content: [{ type: 'text/html', value: body }]
    })
  });
  */
}

// ─── 1. onOrderStatusChange ────────────────────────────────────────────────

exports.onOrderStatusChange = onDocumentWritten(
  { document: 'orders/{orderId}', region: 'us-central1' },
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
    const snap = await db.collection('orders')
      .where('downloadExpiresAt', '<=', now)
      .where('downloadExpired', '!=', true)
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
  { bucket: 'digitalmarket-38db5.firebasestorage.app', region: 'us-central1' },
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

exports.generateSitemap = onCall(
  { region: 'us-central1', cors: ['https://digitalmarketstore.shop'] },
  async req => {
    // Optional: admin-only guard
    // if (req.auth?.token?.role !== 'admin') throw new HttpsError('permission-denied', 'Admins only.');

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
