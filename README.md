# Aemerg

Two things in one folder, sharing one visual identity - a candlelit collage of
photographs with a name set in Bodoni at the centre.

| File | What it is |
| --- | --- |
| `index.html` | The birthday page. One self-contained file, no server. Double-click it. |
| `server.js` + `public/` | **Aemerg** - the friendship app. Needs `npm start`. |

---

## The birthday page - `index.html`

Open it directly in a browser. Nothing to install.

* Click the greeting or the name to type over them; both are saved in the browser.
* Drop photos anywhere on the page, or use **Add photos**. They scatter into the
  collage and persist between visits.
* The date line counts down to **11 September** on its own and switches to
  “TODAY” on the day, when it also sets off sparks every few seconds.
* Photos rest where they are and move only when you move the pointer: the whole
  collage parallaxes, and the one under the cursor lifts, straightens and glows.

---

## Aemerg - the friendship app

Two friends link with a six-digit code. Either one presses a button and the
other gets a popup. If they are offline, it waits on the server and arrives the
moment they open the app.

Six one-tap notes: **Miss You**, **Hug**, **Thinking**, **Laughing**, **Proud**,
**Good Night**. Each carries its own wording and spark colour through the popup,
the activity list and the notification. Miss You is the large button; the rest
sit under it.

Under those is a field for **your own words**, up to 200 characters. A written
note arrives set in italic Bodoni inside the popup, reads back in the activity
list, and queues offline exactly like a tapped one. Text is delivered as text
and rendered with `textContent`, so nothing typed into it can become markup.

Everything runs over the internet: HTTP for the API and for delivery, and
Web Push to reach a closed app. There is no SMS, SIM, phone-call or cellular
code anywhere in it.

### Run it

```
npm install      # once
npm start        # http://localhost:8787
```

To try both sides on one machine, open the app in a normal window and a private
window - they are separate browsers as far as storage is concerned, so each gets
its own account and code.

### Connecting

1. Both people open the app and enter a name. Each is given a **6-digit code**.
2. One types the other's code and sends a request.
3. The other accepts, and both now see their friend on the home screen.

If you type the code of someone who already asked for you, it links immediately
without a second confirmation.

### How nothing gets lost

Every press is written to the server's queue *before* anything is sent, and it
is removed only when the receiving browser acknowledges that exact event id. So:

* Friend offline → it sits in the queue and is delivered on their next connection.
* Delivered but the connection dropped mid-flight → no ack, so it is sent again.
* Sent twice for that reason → the browser remembers the ids it has already
  shown and silently acknowledges the repeat instead of popping it up again.
* **Your** connection down when you press the button → the press is held in your
  browser and sent as soon as the socket is back.

Presence is kept honest with a 25-second ping; a browser that stops answering is
dropped and its friend sees "Offline".

### Deploying to Vercel

Free, and nothing here asks for a card. Two accounts, five values, one push of
a button.

**1. Somewhere to keep the data.** A serverless host has no disk, so the store
lives in a hosted key-value service. Sign in at upstash.com with GitHub, create
a Redis database, open its **REST API** panel and copy:

```
UPSTASH_REDIS_REST_URL     https://xxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN   AY...
```

The free tier allows 10,000 commands a day. Two friends sending each other
notes all evening costs a few dozen.

**2. Push keys.** Open `vapid.json`, or run `npm run keys` to make a pair.

**3. Deploy.** On vercel.com: **Add New > Project**, import this repo, and add
five environment variables before you click Deploy:

| Key | From |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash |
| `VAPID_SUBJECT` | `mailto:` your address |
| `VAPID_PUBLIC_KEY` | `vapid.json` |
| `VAPID_PRIVATE_KEY` | `vapid.json` |

Leave the framework preset alone; `vercel.json` already says the static files
are in `public` and there is nothing to build.

Or from the terminal:

```
npm i -g vercel
vercel        # follow the prompts
vercel --prod
```

**4. Check it.** Open `https://your-app.vercel.app/api/healthz`. You want:

```json
{"ok":true,"store":"hosted","push":true}
```

`"store":"hosted"` is the line that matters.

If it says `"missing"`, the Upstash variables did not arrive. On a serverless
host that is fatal rather than merely untidy: each request gets its own
short-lived container, so a store that is only a file forgets everything
between requests and people are signed out at random. The app refuses to run
that way rather than handing out accounts that disappear, and says so on
screen and at `/healthz`.

#### If you see "Still signed in here"

The screen means the server does not recognise your device, and it keeps your
session rather than dropping you back to sign-up. Check `/api/healthz`:

* `"store":"missing"` - the host has no database configured. Set the two
  Upstash variables and redeploy. The screen says this outright.
* `"store":"hosted"` - the store is fine, so the account really did go. That
  happens if the Upstash database was emptied or swapped. **Start over with a
  new code** is the way out.
* It appears once and then clears itself - the server was simply asleep or
  restarting, which is normal and needs nothing.

#### Why it fits on Vercel now

There is no WebSocket any more. The app asks `/api/poll` every few seconds
while it is in front of you, which says you are here, brings back anything
waiting, and reports whether your friend is around. When the app is closed
Web Push carries the note instead, so polling can stop entirely.

Presence is a key that expires rather than a socket someone is holding, and
the store is split across keys rather than kept as one document, so two
requests arriving at the same instant cannot overwrite each other. Those two
changes are what make it safe on a host that runs each request in its own
short-lived process.

A Hobby project may have twelve functions and there are more routes than that,
so everything arrives through the catch-all at `api/[...path].js` and is
dispatched inside. The local server calls exactly the same handler, so there
is one implementation of every route and no chance of the two drifting.

What you give up against a socket: a note takes up to about three seconds to
appear when both people have the app open, instead of arriving instantly. A
note to a closed app is unaffected, because that was always push.

#### Running it locally

`npm start` needs nothing configured. With no Upstash variables the store
falls back to a file beside `server.js`, using the same commands, so what you
test is what deploys.

#### Also runs on Render

`render.yaml` is still here and still works, on the free plan with the same
Upstash variables. The difference is that Render keeps one process alive, so
polling reaches it without a cold start, but it sleeps after fifteen minutes
idle. Vercel never sleeps but starts a fresh process per request.

### Notifications when the app is closed

Aemerg uses real Web Push, so a note reaches your friend's phone with the app
closed and the browser shut. Turn it on once:

```
node tools/vapid-keys.js     # writes vapid.json, do this once
npm start
```

The server prints `push notifications are on` when it finds the keys. Without
them everything still works, it just cannot reach a closed app, and
**Settings > App** says so rather than failing quietly.

`vapid.json` is this server's identity for push. Keep it, do not commit it, and
do not regenerate it casually: new keys invalidate every subscription anyone
has already made. In production set `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY` and
`VAPID_PRIVATE_KEY` as environment variables instead of shipping the file.

A push is sent whenever your friend is not actually looking at the app, which
is what "closed" means in practice. Being present is something the app claims
only while it is in front of you: the moment it is backgrounded, the screen is
locked or the tab is closed it says so, and stops claiming it. A tab that was
killed outright cannot say anything, so the claim expires on its own within
about ten seconds.

That distinction is the whole thing. If presence merely meant "the tab exists",
a backgrounded app would go on claiming it, the server would think the note had
been seen, and nothing would ever reach the phone.

With the app open in front of them the note arrives in the app and no push is
sent, so nothing arrives twice. A push service reporting a subscription gone
(404 or 410) has it dropped. Every note is queued on the server regardless, so
a push that fails never loses one: it is still there when the app is opened.

Push needs https. On localhost it works as-is; anywhere else put the app behind
TLS. On iPhone it needs iOS 16.4 or later **and** Aemerg added to the Home
Screen first, which Settings will tell you.

### Install it

Aemerg is a PWA. Over https (or on localhost) the browser offers to install it,
and **Settings > App** carries the install button plus what state it is in:

* **Installed** - whether it is running as an app or in a browser tab
* **Works offline** - the service worker caches the shell, so it opens with no
  connection. `/api/` and the WebSocket are never cached: presence and delivery
  are always live, and a cached answer there would be a lie.
* **Notifications** - permission is asked from that button, not on page load
* **Update ready** - appears when a new version is waiting; restarts into it

On iPhone there is no install button: tap Share, then Add to Home Screen.
Settings says so when it detects iOS.

Icons are generated, not hand-drawn: `node tools/make-icons.js` redraws the
whole set from the palette with no image dependencies.

### Staying signed in

Nothing signs you out but you. A session lives in the browser and is removed
only by **Sign out of this browser**, or by **Start over with a new code** on
the screen below.

Shipping a new version does not sign anyone out either. Storage is versioned
and migrated rather than cleared, older key names are carried forward, and the
service worker only ever replaces its own cache. If `localStorage` is
unavailable the app falls back to memory for that session instead of appearing
signed out.

The session is also mirrored into a long-lived cookie. Browsers evict cookies
and `localStorage` under different rules, so whichever one survives restores
the other on the next load. Only signing out clears both.

If the server stops recognising a device (it restarted with no `data.json`, or
was moved), the app does **not** quietly drop back to sign-up. It keeps the
session, says *Still signed in here*, names who the device belongs to, and
offers **Try again**. Reconnecting on its own is enough to clear it.

On the server side an account is written to disk the instant it exists, not
after a delay, so killing the process outright the moment someone registers
cannot lose them. Writes land on a temp file and are renamed over the real one,
so a crash mid-write leaves the previous file intact rather than a truncated
one. Queued notes are saved the same way.

### History

**Recent notes** groups by day and stamps every row with the time it was sent.
The heading reads *Today*, *Yesterday*, then the date (`30 Aug`, and the year
too once it is no longer this year). Hovering a row shows the full weekday,
date and time. Sent and received are marked with the arrow direction, and a
written note shows its own words rather than a generic label.

### Where the data lives

* `data.json` next to `server.js` - accounts, codes, links, pending events and
  activity. Delete it to reset everything.
* The browser's `localStorage` - your session token, your photos, and the ids of
  events already shown to you.

### Look

The surfaces are glass: a dark translucent tint, a blur that samples the photo
collage behind, a bright hairline along the top edge for the specular catch,
and a soft inner sheen. The tint is dark on purpose. A light tint over a dark
ground only brightens whatever photo sits behind it and the text stops being
readable, so the frost comes from the blur and the glass from the rim.

Browsers without `backdrop-filter` get opaque panels through an `@supports`
fallback rather than unreadable transparent ones.

### Layout

```
server.js                    runs the same handler as a local process
public/index.html            the app shell: onboarding, connect, home, settings
public/theme.css             the shared candlelit theme
public/collage.js            the photo backdrop engine
public/app.js                auth, polling, notes, settings, PWA
public/sw.js                 service worker: shell cache, and push while closed
public/manifest.webmanifest  name, colours, icons, standalone display
public/icons/                generated by tools/make-icons.js
tools/make-icons.js          redraws the icon set from the palette
tools/vapid-keys.js          generates vapid.json for push, once
vapid.json                   push identity, generated and not committed
api/[...path].js             the one Vercel function every route arrives at
lib/handler.js               routes a request to the right piece of core
lib/core.js                  what the app does, with no idea how it was asked
lib/store.js                 the keys everything is kept under
lib/local.js                 the same commands against a file, for local runs
lib/push.js                  Web Push
vercel.json                  static root and cache headers
render.yaml                  the free Render service and its env vars
```
