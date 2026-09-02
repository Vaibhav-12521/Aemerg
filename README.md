# Aemerg

Two things in one folder, sharing one visual identity - a candlelit collage of
photographs with a name set in Bodoni at the centre.

| File | What it is |
| --- | --- |
| `index.html` | The birthday page. One self-contained file, no server. Double-click it. |
| `server.js` + `public/` | **Miss You** - the friendship app. Needs `npm start`. |

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

## Miss You - the friendship app

Two friends link with a six-digit code. Either one presses a button and the
other gets a popup. If they are offline, it waits on the server and arrives the
moment they open the app.

Six things you can send: **Miss You**, **Hug**, **Thinking**, **Laughing**,
**Proud**, **Good Night**. Each carries its own icon, wording and spark colour
through the popup, the activity list and the desktop notification. Miss You is
the large button; the rest sit under it.

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

### Where the data lives

* `data.json` next to `server.js` - accounts, codes, links, pending events and
  activity. Delete it to reset everything.
* The browser's `localStorage` - your session token, your photos, and the ids of
  events already shown to you.

### Layout

```
server.js          API, WebSocket hub, pending queue
public/index.html  the app shell: onboarding, connect, home, settings
public/theme.css   the shared candlelit theme
public/collage.js  the photo backdrop engine
public/app.js      auth, sockets, miss-you, geolocation, settings
```
