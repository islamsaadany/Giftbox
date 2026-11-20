/* The first accounts come from the environment, never from the code:
     ADMIN_USERS="Alaa:password,Islam:password"
   They are created in the database on first start. All of them are admins (the only ones who can
   create the other users), unless ADMINS names which of them are:
     ADMINS="Islam"
   Then the rest are ordinary users who keep their sign-in and their lists.
   The older single ADMIN_PASSWORD still works and creates "Admin". */
function readAdmins(env) {
  const accounts = [];
  for (const part of String(env.ADMIN_USERS || '').split(',')) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const name = part.slice(0, i).trim(), password = part.slice(i + 1).trim();
    if (name && password.length >= 4) accounts.push({ name, password });
  }
  if (!accounts.length && env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 4) accounts.push({ name: 'Admin', password: env.ADMIN_PASSWORD });
  const only = String(env.ADMINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const a of accounts) a.admin = !only.length || only.includes(a.name.toLowerCase());
  return accounts;
}
module.exports = { readAdmins };
