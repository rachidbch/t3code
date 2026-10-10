import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE web_push_devices (device_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, origin TEXT NOT NULL, subscription TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, after_sequence INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE web_push_watch_state (thread_id TEXT PRIMARY KEY, watch_count INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE web_push_cursor (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE web_push_deliveries (device_id TEXT NOT NULL, identity TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(device_id, identity))`;
  yield* sql`CREATE INDEX web_push_due ON web_push_deliveries(status, due_at)`;
});
