// cPanel "Setup Node.js App" startup file for the user API (e.g. api.yourdomain.com).
// Passenger loads startup files with require(); the application itself is an ES module.
import('./dist/entry-api.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
