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

Everything runs over the internet - HTTP for the API, a WebSocket for live
delivery. There is no SMS, SIM, phone-call or cellular code anywhere in it.

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

### Location

Latitude and longitude appear **only in Settings**, and only after you press
**Allow location** and grant the browser prompt. The coordinates never leave the
browser - they are not sent to the server and not shared with your friend.

Browsers only expose geolocation on a secure origin. `http://localhost:8787`
counts as secure, so it works on the machine running the server. Reaching the
app from another device over a plain LAN address (`http://192.168.x.x:8787`)
does not, and Settings will say *Unavailable here*. Put it behind HTTPS - a
tunnel such as `cloudflared tunnel --url http://localhost:8787` is the quickest
way - and location works everywhere.

### Deploying to Render

Aemerg needs a real Node process, a WebSocket, and somewhere to keep
`data.json`. Render gives all three. `render.yaml` in this repo describes the
service, so Render can set it up from the file rather than a form.

**1. Get your push keys ready.** If you have not made a pair:

```
npm run keys
```

Open `vapid.json`. You will paste the three values into Render in step 3.

**2. Create the service.**

* Push this repo to GitHub, then on Render choose **New > Blueprint** and point
  it at the repo. Render reads `render.yaml` and offers the service.
* Or **New > Web Service**: build `npm ci --omit=dev`, start `node server.js`,
  health check path `/healthz`.

**3. Set the environment variables** when Render prompts:

| Key | Value |
| --- | --- |
| `VAPID_SUBJECT` | `mailto:you@yourdomain.com` |
| `VAPID_PUBLIC_KEY` | from `vapid.json` |
| `VAPID_PRIVATE_KEY` | from `vapid.json` |
| `DATA_DIR` | `/var/data` (already in the blueprint) |

`PORT` is set by Render. Do not set it yourself.

**4. Check the disk is attached.** Mount path `/var/data`, 1 GB is plenty.
This is the part that matters: it is what makes accounts, friendships and
queued notes outlive a deploy.

**5. Deploy.** The log should read:

```
push notifications are on
Aemerg is running on port 10000
  store: /var/data/data.json
```

Open `https://your-app.onrender.com/healthz` and you should get
`{"ok":true,"push":true,...}`.

#### Do not use the free instance

A free Render instance has **no disk**, so `data.json` is gone on every deploy
and restart: every account disappears and everyone lands on the *Still signed
in here* screen. It also sleeps after 15 minutes idle, which drops the
WebSocket. The blueprint asks for `starter` for exactly these reasons.

#### What you get once it is live

HTTPS is automatic, which is what the rest of the app has been waiting for:

* **Location** works in Settings on a phone, not just on localhost.
* **Install** is offered on Android and iOS.
* **Push** reaches a closed app, which needs https to work at all.

#### Keep the same keys

The VAPID keys are the server's push identity. If you change them, every
subscription already made stops working and nobody gets a notification until
they open the app again. Set them once in Render and leave them.

#### One instance only

Presence and the socket map live in process memory, so scale this to exactly
one instance. Two instances behind a load balancer would not see each other's
users. That is fine for a handful of people and a wall for anything larger.

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

A push is sent only when the note could not be handed to a live socket, which
is exactly the case that matters: your friend's app is closed. If they have it
open the socket delivers it and no push is sent, so nothing arrives twice. A
push service reporting a subscription gone (404 or 410) has it dropped. Every
note is still queued on the server regardless, so push failing never loses one.

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
server.js                    API, WebSocket hub, pending queue
public/index.html            the app shell: onboarding, connect, home, settings
public/theme.css             the shared candlelit theme
public/collage.js            the photo backdrop engine
public/app.js                auth, sockets, notes, geolocation, settings, PWA
public/sw.js                 service worker: shell cache, and push while closed
public/manifest.webmanifest  name, colours, icons, standalone display
public/icons/                generated by tools/make-icons.js
tools/make-icons.js          redraws the icon set from the palette
tools/vapid-keys.js          generates vapid.json for push, once
vapid.json                   push identity, generated and not committed
render.yaml                  the Render service, disk and env vars
```
