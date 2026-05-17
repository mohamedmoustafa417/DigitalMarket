# Resend DNS Setup Guide — for Namecheap

You need to add **4 DNS records** at Namecheap so Resend can send mail
from `digitalmarketstore.shop`. **The records do NOT conflict with your
PrivateEmail inbox** — Resend uses a `send.` subdomain.

---

## Step 1 — Get the records from Resend

1. Open https://resend.com/domains
2. Click the **digitalmarketstore.shop** entry (status: Failed)
3. Click the **Records** tab
4. You'll see exactly 4 rows like this (the actual values will be different):

```
Type   Host                                        Value
─────  ──────────────────────────────────────────  ──────────────────────────────────────────
MX     send                                        feedback-smtp.us-east-1.amazonses.com (priority 10)
TXT    send                                        v=spf1 include:amazonses.com ~all
TXT    resend._domainkey                           p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBi...   (a very long string)
TXT    _dmarc                                      v=DMARC1; p=none;
```

Keep this tab open — you'll copy each row to Namecheap.

---

## Step 2 — Add them at Namecheap

1. Log in to https://ap.www.namecheap.com → Domain List
2. Find `digitalmarketstore.shop` → click **Manage**
3. Click the **Advanced DNS** tab (not "Mail Settings")
4. Scroll to **Host Records** section, click **Add New Record** for each one:

### Row 1 — MX record

| Field in Namecheap | Value to enter |
|---|---|
| Type | **MX Record** |
| Host | `send`   ← NOT `@`, just the word `send` |
| Mail Server | `feedback-smtp.us-east-1.amazonses.com` (copy from Resend) |
| Priority | `10` |
| TTL | `Automatic` |

### Row 2 — TXT record for SPF

| Field | Value |
|---|---|
| Type | **TXT Record** |
| Host | `send` |
| Value | `v=spf1 include:amazonses.com ~all` (copy from Resend) |
| TTL | `Automatic` |

### Row 3 — TXT record for DKIM (the long one)

| Field | Value |
|---|---|
| Type | **TXT Record** |
| Host | `resend._domainkey` |
| Value | (paste the long `p=MIGfM...` string from Resend exactly — no quotes, no line breaks) |
| TTL | `Automatic` |

### Row 4 — TXT record for DMARC

| Field | Value |
|---|---|
| Type | **TXT Record** |
| Host | `_dmarc` |
| Value | `v=DMARC1; p=none;` |
| TTL | `Automatic` |

Click the green ✓ checkmark to save each row.

---

## Step 3 — Wait + verify

1. DNS propagation usually takes **5-15 minutes**, occasionally up to 1 hour.
2. Go back to https://resend.com/domains
3. Click **Restart** (top right of your domain card)
4. Resend will re-check and turn the status to **Verified** ✅

---

## Step 4 — Test end-to-end

Once Resend shows **Verified**:

1. Open https://digitalmarketstore.shop as admin
2. **Triple-click the footer logo** (or press `Ctrl+Shift+I`) to open the
   Integrations modal
3. Scroll to the **📧 Email deliverability** section
4. Click **"Send test email to me"**
5. Within 1-3 minutes, your `support@digitalmarketstore.shop` PrivateEmail
   inbox should receive: *"DigitalMarket email health check — …"*

If you got the email → **everything works end-to-end**. Real order
approvals will send the same way.

---

## ⚠ Common gotchas

| Problem | Fix |
|---|---|
| Records exist but Resend still says "Failed" | Wait 15 min, then click **Restart** in Resend. DNS sometimes takes that long. |
| Namecheap shows "Conflicting record" | You probably already have a record at `_dmarc` or `send`. If so: edit the existing one to match Resend's exact value, don't create a duplicate. |
| Long DKIM string gets line-broken | Paste it without any line breaks — Namecheap's text field handles long strings fine. |
| PrivateEmail stops receiving mail after adding records | Should not happen — Resend uses subdomain `send.` so MX records at root stay untouched. If it does happen, check your root MX records (`@`) still point to `mx1.privateemail.com` and `mx2.privateemail.com`. |

---

## After verification

I'll mark these as resolved in the launch checklist:
- ✅ Item #1 (Email provider) — fully complete
- ✅ Item #3 (Support inbox) — already done
- ✅ Most-critical workflow: order-approval-email end-to-end works
