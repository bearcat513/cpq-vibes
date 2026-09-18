/**
 * Runs once per boot, before the app starts serving.
 *
 * Same isolation rule as everything else here: the handler body cannot see
 * this file's scope, so it requires its dependency inside itself.
 */
module.exports.register = () => {
  onBootstrap(e => {
    // onBootstrap fires *before* initialisation — nothing on e.app is usable
    // until next() has run.
    e.next();

    require(`${__hooks}/lib/superuser.js`).ensure(e.app);
  });
};
