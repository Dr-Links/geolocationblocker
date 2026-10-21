// cPanel "Setup Node.js App" startup file for the admin dashboard (e.g. admin.yourdomain.com).
import('./dist/entry-admin.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
