# Wishbox

Gift lists you share with a link. Anyone can create an account, make their own lists and add gifts; guests open a list's link, see only what is still available, and reserve one (or some pieces of one) with their name and mobile number.

- **Accounts**: `/admin`. Each person signs up with a username and password and sees only their own lists: items, every reservation (name, mobile, how many, date), release per reservation.
- **Guests**: `/l/<slug>`, a random 8-character link per list. The guest API never returns reservations, names or mobiles.

## Publish on Vercel

In the Vercel project:

1. **Storage → Create Database → Neon (Postgres)** and connect it to the project. This adds `DATABASE_URL`.
2. **Storage → Create → Blob**, with **public** access, and connect it to the project. This adds `BLOB_READ_WRITE_TOKEN`. Item pictures are stored here.
3. Redeploy. The tables are created automatically on the first request.

Until both are set, every page says what is missing. On Vercel the app runs from `api/index.js`; `vercel.json` sends every request there.

## Run it locally

Needs Node 22 or newer. Without `DATABASE_URL` it uses an embedded Postgres and a photos folder inside `DATA_DIR`, so nothing else has to be installed.

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3000/admin and create an account.

| Variable | Meaning | Default |
| --- | --- | --- |
| `ADMIN_USERS` | Optional first accounts as `Name:password,Name:password`, created once in the database. Lists from before accounts existed go to the first one | none |
| `DATABASE_URL` | Postgres connection string (`POSTGRES_URL` also works) | embedded database in `DATA_DIR` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token for pictures | pictures saved in `DATA_DIR` |
| `DATA_DIR` | Folder for local data | `./data` |
| `PORT` | Port to listen on | `3000` |

## Data

Postgres tables: `users`, `lists` (each owned by a user), `items`, `reservations`, plus `sessions` and `login_failures` for the sign-in. Passwords are stored as scrypt hashes; there is no password recovery. Pictures are JPEGs, resized in the browser to at most 640px before upload.

Reserving locks the item and re-checks the pieces left inside a transaction, so two guests can't take the same last pieces. The owner can't set a quantity below what is already reserved.

## Tests

```bash
npm test
```

Set `TEST_DATABASE_URL` to run them against a real Postgres instead of the embedded one.
