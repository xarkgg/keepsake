import assert from "node:assert/strict";
import test from "node:test";
import { signInWithFallback } from "../src/lib/sign-in.js";

/**
 * The sign-in decision is a pure rule over injected calls, so every path is
 * checked here without a browser, Firebase, or a server: which store answers
 * the attempt, when the fallback runs, and which error reaches the person when
 * neither store accepts the credentials.
 */

function store(name: string, outcome: "ok" | Error) {
  let calls = 0;
  return {
    name,
    get calls() {
      return calls;
    },
    call: async () => {
      calls += 1;
      if (outcome instanceof Error) throw outcome;
    },
  };
}

test("without Firebase the app's own password check answers", async () => {
  const server = store("server", "ok");
  const path = await signInWithFallback({
    firebaseReady: false,
    firebaseSignIn: async () => {
      throw new Error("Firebase should not be asked");
    },
    serverSignIn: server.call,
  });
  assert.equal(path, "server");
  assert.equal(server.calls, 1);
});

test("with Firebase configured and happy, no fallback runs", async () => {
  const firebase = store("firebase", "ok");
  const server = store("server", new Error("server must not be asked"));
  const path = await signInWithFallback({
    firebaseReady: true,
    firebaseSignIn: firebase.call,
    serverSignIn: server.call,
  });
  assert.equal(path, "firebase");
  assert.equal(firebase.calls, 1);
  assert.equal(server.calls, 0);
});

test("an account Firebase does not know falls back to the app's own check", async () => {
  const firebase = store("firebase", new Error("auth/invalid-credential"));
  const server = store("server", "ok");
  const path = await signInWithFallback({
    firebaseReady: true,
    firebaseSignIn: firebase.call,
    serverSignIn: server.call,
  });
  assert.equal(path, "server");
  assert.equal(firebase.calls, 1);
  assert.equal(server.calls, 1);
});

test("this covers a Firebase identity the server refuses to link", async () => {
  // An unverified Firebase address fails at the server exchange, not at the
  // Firebase sign-in. The same fallback must still reach the app's own check
  // for an account that has an app-side password.
  const firebase = store("firebase", new Error("Verify that email address before signing in with it."));
  const server = store("server", "ok");
  const path = await signInWithFallback({
    firebaseReady: true,
    firebaseSignIn: firebase.call,
    serverSignIn: server.call,
  });
  assert.equal(path, "server");
});

test("when neither store accepts the credentials, the Firebase error wins", async () => {
  const firebaseError = new Error("auth/invalid-credential");
  const firebase = store("firebase", firebaseError);
  const server = store("server", new Error("No account with that email, or the password is wrong."));
  await assert.rejects(
    signInWithFallback({
      firebaseReady: true,
      firebaseSignIn: firebase.call,
      serverSignIn: server.call,
    }),
    (err: unknown) => err === firebaseError,
  );
  assert.equal(firebase.calls, 1);
  assert.equal(server.calls, 1);
});
