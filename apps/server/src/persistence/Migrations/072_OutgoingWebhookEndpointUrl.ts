import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Null means the endpoint is a secret kept in the secret store, which every existing row is.
  // A set value is an endpoint the user chose to keep as ordinary, readable configuration.
  yield* sql`ALTER TABLE outgoing_webhooks ADD COLUMN endpoint_url TEXT`;
});
