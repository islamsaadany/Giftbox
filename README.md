# Wishbox

Gift lists you share with a link. An admin gives each person a username and password; each person makes their own lists and adds gifts; guests open a list's link, see only what is still available, and reserve one (or some pieces of one) with their name and mobile number.

- **Users**: `/admin`. Each person signs in with the username and password the admin gave them and sees only their own lists: items, every reservation (name, mobile, how many, date), release per reservation.
- **Collaborators**: a list's owner can add other users by username under **Collaborators**. They see the list and its reservations and can rename it, add, edit and delete its gifts, and release reservations. Only the owner deletes the list or chooses collaborators; a collaborator can leave.
- **On a phone**: `/admin` can be added to the home screen (Share → Add to Home Screen on iPhone, menu → Install app / Add to Home screen on Android). It then opens full screen with its own icon. It still needs a connection: nothing works offline.
- **Colour**: each user picks a colour theme (pink, light blue, teal, green, purple, orange) under **Colour**. Their guests see their lists in it too.
- **Admins**: the accounts named in `ADMIN_USERS`, or only those listed in `ADMINS` when it is set. They get a **Users** page to create users, open any user's lists and change them like the owner can (gifts, reservations, name, collaborators, delete), set a new password for anyone, and delete users. There is no sign-up. Admins can also keep lists of their own.
- **Guests**: `/l/<slug>`, a random 8-character link per list. The guest API never returns reservations, names or mobiles.

## Publish on Vercel

In the Vercel project:

1. **Storage → Create Database → Neon (Postgres)** and connect it to the project. This adds `DATABASE_URL`.
2. **Storage → Create → Blob**, with **public** access, and connect it to the project. This adds `BLOB_READ_WRITE_TOKEN`. Item pictures are stored here.
3. **Settings → Environment Variables**: add `ADMIN_USERS` with each admin as `Name:password`, separated by commas, e.g. `Alaa:their-password`.
4. Redeploy. The tables are created automatically on the first request.

Until all three are set, every page says what is missing. On Vercel the app runs from `api/index.js`; `vercel.json` sends every request there.

## Run it locally

Needs Node 22 or newer. Without `DATABASE_URL` it uses an embedded Postgres and a photos folder inside `DATA_DIR`, so nothing else has to be installed.

```bash
npm install
```

```bash
ADMIN_USERS='Alaa:a-long-password' npm start
```

Then open http://localhost:3000/admin and sign in as the admin. Add everyone else under **Users**.

| Variable | Meaning | Default |
| --- | --- | --- |
| `ADMIN_USERS` | The admins as `Name:password,Name:password` (required). Names can't contain `:` or `,`; passwords can't contain `,`. The password is only used to create the account the first time; after that, change it on the Users page. Lists from before accounts existed go to the first admin | none |
| `ADMINS` | Optional. Names from `ADMIN_USERS` who are admins, e.g. `Islam`. The other `ADMIN_USERS` accounts are then ordinary users who keep their sign-in and lists, and lists from before accounts existed go to the first of them | everyone in `ADMIN_USERS` |
| `DATABASE_URL` | Postgres connection string (`POSTGRES_URL` also works) | embedded database in `DATA_DIR` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token for pictures | pictures saved in `DATA_DIR` |
| `DATA_DIR` | Folder for local data | `./data` |
| `PUBLIC_URL` | Address guests open, used for the copied guest link, e.g. `https://gifts.example.com` | on Vercel the production domain, otherwise the address the admin is on |
| `PORT` | Port to listen on | `3000` |

## Data

Postgres tables: `users`, `lists` (each owned by a user), `list_collaborators`, `items`, `reservations`, plus `sessions` and `login_failures` for the sign-in. Passwords are stored as scrypt hashes; a forgotten one is replaced by an admin on the Users page. Pictures are JPEGs, resized in the browser to at most 640px before upload.

Reserving locks the item and re-checks the pieces left inside a transaction, so two guests can't take the same last pieces. The owner can't set a quantity below what is already reserved.

## Tests

```bash
npm test
```

Set `TEST_DATABASE_URL` to run them against a real Postgres instead of the embedded one.
