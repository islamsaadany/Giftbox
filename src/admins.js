/* Optional first accounts from the environment:
     ADMIN_USERS="Alaa:password,Islam:password"
   They are created in the database on first start; everyone else signs up in the app.
   The older single ADMIN_PASSWORD still works and creates "Admin". */
function readAdmins(env) {
  const admins = [];
  for (const part of String(env.ADMIN_USERS || '').split(',')) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const name = part.slice(0, i).trim(), password = part.slice(i + 1).trim();
    if (name && password.length >= 4) admins.push({ name, password });
  }
  if (!admins.length && env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 4) admins.push({ name: 'Admin', password: env.ADMIN_PASSWORD });
  return admins;
}
module.exports = { readAdmins };
