const { DatabaseSync } = require("node:sqlite");

const databasePath = process.argv[2];
const reasoningLevel = process.argv[3];

if (!databasePath || !/^[a-z][a-z0-9-]{0,31}$/i.test(reasoningLevel || "")) {
  throw new Error("Invalid ZCode reasoning settings");
}

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 5000");
const now = Date.now();
database
  .prepare(`
    insert into local_setting (
      scope, scope_id, namespace, key, value,
      schema_version, time_created, time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(scope, scope_id, namespace, key) do update set
      value = excluded.value,
      schema_version = excluded.schema_version,
      time_updated = excluded.time_updated
  `)
  .run(
    "user",
    "default",
    "model",
    "reasoningLevel",
    JSON.stringify({ level: reasoningLevel }),
    1,
    now,
    now,
  );
database.close();
