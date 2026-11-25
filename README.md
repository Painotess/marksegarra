# Mark Website — Memory Album 💛

Romantic memory album (Pictures · Videos · Music · Love Messages) na may Admin (macky) at View-only (Mark) login.
Lahat ng ina-upload ni macky ay **nase-save sa GitHub repo mo** at **lumalabas agad kay Mark** sa live website (Vercel).

| Account | Username | Password | Pwede |
|---|---|---|---|
| Admin | `macky` | `1009` | Mag-upload, mag-delete, mag-edit ng text |
| User | `Mark` | `mark` | Tumingin lang |

## Paano i-deploy (mga 10 minuto)

### 1. GitHub
1. Gumawa ng **bagong repo** sa GitHub (halimbawa `mark-memory-album`). **Gawing *Private*** (importante: nandoon ang mga pictures/videos at ang login info).
2. I-upload/push ang laman ng folder na ito sa `main` branch.

### 2. GitHub token (para maka-save ang website)
1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. *Repository access*: **Only select repositories** → piliin ang repo mo.
3. *Permissions → Repository permissions → **Contents: Read and write***.
4. I-copy ang token (`github_pat_...`).

### 3. Vercel
1. [vercel.com](https://vercel.com) → **Add New → Project** → i-import ang repo.
2. Huwag galawin ang build settings (walang build). Bago mag-Deploy, buksan ang **Environment Variables** at idagdag:

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | ang token mula sa step 2 |
| `GITHUB_REPO` | `iyong-username/mark-memory-album` |
| `SESSION_SECRET` | kahit anong mahabang random na text |

3. **Deploy**. Tapos na! Buksan ang link, mag-login bilang `macky`.

> Kung nagdagdag ka ng env variables *pagkatapos* mag-deploy, mag-**Redeploy** para magamit.

## Saan nase-save ang mga ina-upload?
- Sa **`data` branch** ng repo mo (kusang ginagawa), sa folder `album/`:
  `album/db.json` (listahan + mga custom na text) at `album/uploads/...` (mga file).
- Hindi nito ni-re-redeploy ang Vercel kapag nag-upload ka (naka-off ang deploy para sa `data` branch sa `vercel.json`).

## Mga dapat tandaan
- **Limit: 3 MB bawat video/music file** (limit ng Vercel). Ang **pictures** ay awtomatikong nire-resize kaya okay lang kahit malaki.
  Para sa mas mahabang video: gamitin ang **"Paste link"** (YouTube *unlisted* link ang pinakamadali; tumutugtog mismo sa popup).
- **Edit Text** (macky lang): pindutin ang *Edit Text* → i-click ang kahit anong naka-dashed na text (title, subtitle, tab names…) → i-type → kusang nase-save. May *Login page texts* button para sa login page, at *Reset all* para ibalik sa English.
- Palitan ang username/password sa Vercel env vars (optional): `ADMIN_USER`, `ADMIN_PASS`, `USER_USER`, `USER_PASS`.
- Kapag **Private** ang repo, ligtas ang laman. Ang default na login ay nasa `api/_lib.js` — kaya huwag gawing Public ang repo, o ilagay ang sarili mong login sa env vars.

## Subukan sa sarili mong computer
- Buksan lang ang `public/index.html` (o `npx serve public`) → **Preview mode**: lahat ay nase-save lang sa browser na iyon (IndexedDB). Para sa tunay na GitHub saving: `npx vercel dev` na may `.env` (tingnan ang `.env.example`).

## Istruktura
```
public/        index.html · styles.css · app.js · seed.js
api/           auth.js (login) · db.js · items.js (add/delete) · texts.js · file.js · _lib.js
vercel.json    package.json  .env.example
```
