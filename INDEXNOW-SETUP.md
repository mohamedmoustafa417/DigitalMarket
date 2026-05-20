# Bing IndexNow — Setup Guide

> When configured, every time you approve a new product in admin, the
> Cloud Function pings Bing → product indexed in ~30 seconds.
> Without IndexNow, Bing waits ~24h for the next sitemap regen.
>
> Coverage: Bing, DuckDuckGo, Yandex, Yep, Naver. (Google ignores
> IndexNow and sticks with sitemap.xml — that's already wired up
> via Search Console.)

---

## 1. Generate a key in Bing

1. Open: https://www.bing.com/indexnow
2. Sign in with the same Microsoft account as Bing Webmaster Tools
3. Click **Generate API key**
4. Bing returns a UUID-shaped key, e.g. `a1b2c3d4e5f6789012345678abcdef00`
5. **Copy it.** Don't close the tab yet.

---

## 2. Host the key file at the repo root

Bing requires you to prove you own the domain by hosting a text file
named `{your-key}.txt` at the root of your site, with the key as the
content.

Create the file locally:

```powershell
cd C:\Users\LapTop\Downloads\Claude\deploy
# Replace YOUR_KEY_HERE with the key Bing gave you
Set-Content -Path "YOUR_KEY_HERE.txt" -Value "YOUR_KEY_HERE" -NoNewline
```

Confirm it works:

```powershell
git add YOUR_KEY_HERE.txt
git commit -m "chore: add IndexNow ownership-proof key file"
git push origin master
git checkout main; git merge master --ff-only; git push origin main; git checkout master
```

After GitHub Pages re-publishes (~60 s), verify:

```
https://digitalmarketstore.shop/YOUR_KEY_HERE.txt
```

should show the key as plain text. If you see 404, GitHub hasn't
re-published yet — wait another minute.

---

## 3. Set the Firebase secret

Tell the Cloud Function what key to use when pinging IndexNow:

```powershell
firebase functions:secrets:set INDEXNOW_KEY --project digitalmarket-38db5
# Paste your key when prompted (Ctrl+Shift+V then Enter)
```

Redeploy the function so it picks up the new secret:

```powershell
firebase deploy --only functions:notifyIndexNow --project digitalmarket-38db5 --force
```

---

## 4. Test it

In admin, approve any product. Within ~30 seconds:

1. Firebase Console → Functions → `notifyIndexNow` → **Logs**
2. Should show:
   ```
   [notifyIndexNow] product abc12345 → IndexNow HTTP 200
   ```
3. HTTP 200 / 202 = success. 400-422 = bad request (check the key matches the .txt file).

To independently verify, paste a product URL into:
https://www.bing.com/search?q=URL_HERE — should appear in Bing within 30 min (was 24h before).

---

## 5. Daily quota

IndexNow allows 10,000 URL pings per day per host. We send 1 per
product-approval — comfortably under the limit unless you approve
>10k products/day (in which case you have other problems).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[notifyIndexNow] INDEXNOW_KEY not set` in CF logs | Secret never set OR was set to placeholder | Re-run step 3 with the real key |
| `HTTP 403` from IndexNow | The `.txt` file at the root doesn't match the key | Re-check step 2; key file content must EXACTLY match the key (no trailing newline, no whitespace) |
| `HTTP 422` from IndexNow | URL is on a host other than the one declared | The CF hardcodes `digitalmarketstore.shop` — only ping URLs on that domain |
| No log message at all when approving a product | CF didn't fire | Check Firebase Console → Functions → notifyIndexNow → Triggered. If not triggered, the trigger pattern in code expects `products/{productId}` write |

---

## Cost

Free. IndexNow has no per-call charge; Cloud Function invocations are
~$0.00000016 each; one ping = one CF invocation = ~$0.00001/month for
typical product-listing volume. Effectively free.
