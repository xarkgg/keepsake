import assert from "node:assert/strict";
import test from "node:test";
import { SessionRequests } from "../src/lib/session-requests.js";

test("a bootstrap started before sign-out cannot publish after the next sign-in", () => {
  const session = new SessionRequests();
  const previous = session.beginLoad()!;
  const logout = session.beginChange();
  assert.equal(session.beginLoad(), null);
  const login = session.beginChange();
  assert.equal(logout.finish(), false);
  assert.equal(session.beginLoad(), null);
  assert.equal(login.finish(), true);
  const next = session.beginLoad()!;
  assert.equal(previous(), false);
  assert.equal(next(), true);
});

test("a newer refresh supersedes both a late success and a late error", () => {
  const session = new SessionRequests();
  const first = session.beginLoad()!;
  const second = session.beginLoad()!;
  assert.equal(first(), false);
  assert.equal(second(), true);
});
