# Google Drive Per-Buyer Sharing — Setup Guide

> Once configured, every buyer who downloads a Drive-hosted product gets
> their **own** Drive permission granted at download time. After 30 days
> the daily `revokeExpiredDriveGrants` Cloud Function automatically
> removes their access. Reshared links to non-buyers will hit "permission
> denied" on Drive's side.

If you don't set this up, downloads still work — but they use the public
Drive link as before (anyone with the link can access).

---

## 1. Create a Google Cloud service account

1. Go to https://console.cloud.google.com/iam-admin/serviceaccounts
2. Pick the **digitalmarket-38db5** project
3. Click **+ CREATE SERVICE ACCOUNT**
4. Name it `digitalmarket-drive-sharing`. Click **CREATE AND CONTINUE**.
5. Skip the "Grant access" steps (we'll handle access at the file level).
   Click **DONE**.
6. Find your new service account in the list, click into it.
7. Tab **KEYS** → **ADD KEY** → **Create new key** → **JSON** → **CREATE**.
   A JSON file downloads — keep it private. It looks like:
   ```json
   {
     "type": "service_account",
     "project_id": "digitalmarket-38db5",
     "client_email": "digitalmarket-drive-sharing@digitalmarket-38db5.iam.gserviceaccount.com",
     ...
   }
   ```
8. **Copy the `client_email`** value — you'll need it in step 3.

---

## 2. Enable the Google Drive API

1. https://console.cloud.google.com/apis/library/drive.googleapis.com
2. Click **ENABLE** (skip if already enabled).

---

## 3. Share each product file with the service account

The service account can only grant permissions on files it owns or has
edit access to. So you need to give it access ONCE per file/folder you'll
sell:

**Option A — share each file:**
1. In Google Drive, right-click the product file → **Share**
2. Paste the service-account email (from step 1.8)
3. Set permission to **Editor**
4. Untick "Notify people"
5. Click **Share**

**Option B — better for many files: shared Drive**
1. Create a Shared Drive (or use an existing one)
2. Add the service-account email as a Manager
3. Move all product files into that Shared Drive
4. Any new file dropped in is automatically shareable

---

## 4. Store the JSON as a Firebase secret

```powershell
# From the project root
cd C:\Users\LapTop\Downloads\Claude\deploy

# Paste the entire JSON contents when prompted (Ctrl+Shift+V then Enter)
firebase functions:secrets:set GDRIVE_SA_JSON --project digitalmarket-38db5
```

Then redeploy the two functions that use it:

```powershell
firebase deploy --only functions:downloadFile,functions:revokeExpiredDriveGrants --project digitalmarket-38db5
```

---

## 5. Verify

1. As a test buyer, place + approve an order for a Drive-hosted product
2. Click **Download** in `/orders`
3. Inside Firebase Console → Firestore → `/driveGrants` you should see a
   new doc with the buyer's email and a `permissionId`.
4. In Google Drive, open the file's Share dialog — you should see the
   buyer's email listed as a Reader.
5. After 30 days the daily 02:00 UTC scheduler revokes the grant. Or
   manually trigger from Firebase Console → Functions → `revokeExpiredDriveGrants` → Run.

---

## How the flow works under the hood

```
Buyer clicks Download → downloadFile CF runs
  • Validates Firebase ID token + buyerId + order status + expiry
  • Detects Drive URL via regex on product.downloadUrl
  • If GDRIVE_SA_JSON secret is set:
      - Extract Drive file ID
      - Check /driveGrants/{orderId__productId} — if grant exists,
        reuse the permissionId (no duplicate share)
      - Otherwise call drive.permissions.create({
          type: 'user', role: 'reader',
          emailAddress: order.buyerEmail,
          sendNotificationEmail: false
        })
      - Save the grant doc with expiresAt = now + 30 days
      - Return https://drive.google.com/uc?export=download&id={fileId}
  • Client opens that URL in a new tab → buyer signed into Drive with
    the granted email → Drive accepts the request → file streams

Daily 02:00 UTC:
  revokeExpiredDriveGrants
    • Queries /driveGrants where revokedAt==null AND expiresAt<=now
    • For each: drive.permissions.delete(fileId, permissionId)
    • Flips revokedAt = serverTimestamp
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Buyer gets "You need permission" on Drive | Buyer signed into Drive with a different email than the one on their DigitalMarket account |
| `[drive] grant failed: File not found` in logs | Service account doesn't have access to that Drive file → re-do step 3 |
| `[drive] grant failed: insufficientPermissions` | Drive API not enabled (step 2) or service account JWT scope mismatch |
| Buyers still see public Drive link | `GDRIVE_SA_JSON` secret isn't set — verify with `firebase functions:secrets:access GDRIVE_SA_JSON` |
| Revoke doesn't happen | Check scheduler ran: Firebase Console → Functions → revokeExpiredDriveGrants → Logs |

---

## Cost

- Drive API calls: 10,000 free per day; we use 2 per download (create +
  later delete). At ~100 downloads/day that's 200 calls — far under the
  free tier.
- Service account auth: free.
- The daily scheduler runs 1×/day → invocation cost ~$0.
