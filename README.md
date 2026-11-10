# Daily Verse

A daily Bible passage, a short reflection, a prayer and sometimes a video, with a discussion for each day.
Anyone with the link can read it and comment by typing their name. No account needed.

- **Site:** https://iolom.github.io/daily-verse/
- **Admin:** https://iolom.github.io/daily-verse/admin.html

## How it works

- Plain HTML, CSS and JavaScript (no build step), hosted on **GitHub Pages** from the `main` branch.
  Pushing to `main` updates the site within a minute or two.
- Data lives in **Supabase** (project `daily-verse`, ref `xuzazydksvsgocyzkqxr`, London).
  The publishable key in `assets/config.js` is meant to be public: the database's security rules decide what anyone can do.
- Each day is one row in `posts`, keyed by its date. A day becomes visible to visitors at **midnight UK time**
  on its date (enforced in the database), so scheduling ahead needs no timers.
- Comments go through the `add_comment` database function, which checks lengths, only allows days that have arrived,
  and limits each connection to 5 comments a minute. It returns a secret key that lets that browser delete its own comment.
  The admin can delete any comment.
- The **first account ever created becomes the admin**. After that, the database refuses new accounts.
- Videos: a YouTube, Vimeo or Google Drive link is embedded; files can also be uploaded (50 MB limit) to the
  public `videos` storage bucket (admin only).
- Bible text is **NIV or ESV** (UK/Anglicised editions). There's no free automatic feed that fits a site keeping every day's text,
  so the editor's "Open …" button opens the passage on Bible Gateway and the verse box tidies pasted text
  (removes footnote/cross-reference letters, makes verse numbers small: `cleanPastedVerses` in `assets/common.js`).
  Biblica and Crossway each allow up to 500 quoted verses without asking, with the copyright notices in the footer;
  Settings shows a running count.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `assets/app.js` | The public site: today, any day (`#/day/YYYY-MM-DD`), past days (`#/past`) |
| `admin.html`, `assets/admin.js` | Sign in, schedule, editor, comments, settings |
| `assets/common.js` | Shared helpers (dates in UK time, text formatting, video links) |
| `assets/style.css` | All styling, light and dark |
| `supabase/migrations/` | Database tables, security rules and functions |
| `tools/serve.mjs` | Local preview: `node tools/serve.mjs` then open http://localhost:5800 |

## Changing the database

Add a new file in `supabase/migrations/` and run, from this folder:

```bash
supabase db push --linked -p "$(cat supabase/.db-password)"
```

The database password is in `supabase/.db-password` (never committed).

## Adding a second admin later

Sign-ups are closed once an admin exists. To add another admin: temporarily disable the
`daily_verse_guard_signup` trigger on `auth.users`, let the person create their account on the admin page,
insert their user id into `public.admins`, then re-enable the trigger.
