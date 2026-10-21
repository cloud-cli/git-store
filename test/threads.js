import assert from "node:assert/strict";
import { createThreadStore } from "../threads.js";

const calls = [];
const store = createThreadStore({
  async query(mode, sql, bindings = []) {
    calls.push({ mode, sql, bindings });
    return { changes: 1 };
  },
});
const result = await store.create({
  org: "team",
  repo: "code",
  commit: "a".repeat(40),
  path: "src/a.js",
  selection: { startLine: 2, endLine: 4 },
  comment: "Initial note",
  author: "user-1",
});
assert.equal(result.org, "team");
assert.equal(result.comment, "Initial note");
assert.equal(result.author, "user-1");
const insert = calls.find(({ sql }) => sql.startsWith("INSERT INTO threads"));
assert.ok(insert);
assert.equal(insert.bindings[2], "code");
assert.equal(insert.bindings[3], "a".repeat(40));
assert.equal(JSON.parse(insert.bindings[5]).endLine, 4);
assert.equal(insert.bindings[6], "Initial note");
assert.equal(insert.bindings[7], "user-1");
console.log("Thread store tests passed.");
