# Wishbox

Gift lists you share with a link. The admin creates lists and adds gifts; guests open a list's link, see only what is still available, and reserve one (or some pieces of one) with their name and mobile number.

- **Admin**: `/admin`, behind a password. Lists, items, every reservation (name, mobile, how many, date), release per reservation.
- **Guests**: `/l/<slug>`, a random 8-character link per list. The guest API never returns reservations, names or mobiles.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
```

```bash
ADMIN_PASSWORD='choose-a-long-password' npm start
```

Then open http://localhost:3000/admin.

| Variable | Meaning | Default |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Admin password, at least 8 characters (required) | none |
| `DATA_DIR` | Folder for the database and photos | `./data` |
| `PORT` | Port to listen on | `3000` |

## Data

Everything lives in `DATA_DIR`: `wishbox.db` (SQLite: `lists`, `items`, `reservations`, `sessions`) and `photos/` (JPEGs, resized in the browser to at most 640px before upload). Back up that folder to back up the app.

Reserving runs in a transaction that re-checks the pieces left, so two guests can't take the same last pieces. The admin can't set a quantity below what is already reserved.

## Publish it

Any host that runs a Docker container (or Node) **with a persistent disk** works, e.g. Fly.io, Railway, Render or a small VPS:

1. Deploy this repo with the included `Dockerfile`.
2. Mount a persistent volume at `/data`. Without it, lists and photos are lost on every redeploy.
3. Set the `ADMIN_PASSWORD` secret.
4. Serve it over HTTPS (these hosts do so by default) and run a single instance.

## Tests

```bash
npm test
```
