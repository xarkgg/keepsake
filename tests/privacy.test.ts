import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConsent,
  ConsentGate,
  SanitizationError,
  approve,
  checkConsent,
  isClean,
  prepare,
  redact,
  sha256Hex,
  type ConsentRequest,
} from "../shared/privacy/index.js";

// --- sha256 sanity (so consent binding rests on a correct digest) ----------

test("sha256Hex matches known vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("The quick brown fox jumps over the lazy dog"),
    "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
  );
  // Over 55 bytes exercises the two-block padding path.
  assert.equal(
    sha256Hex("a".repeat(64)),
    "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
  );
});

// --- detection ------------------------------------------------------------

test("detects an email and redacts it", () => {
  const result = redact("Reach me at jane.doe+work@example.co.uk tomorrow.");
  assert.equal(result.count, 1);
  assert.equal(result.findings[0]?.rule, "email");
  assert.equal(result.text, "Reach me at [email#1] tomorrow.");
  assert.ok(!result.text.includes("jane.doe"));
});

test("a card number is read as a card, not as a phone number", () => {
  // 4242 4242 4242 4242 is a valid Luhn number.
  const result = redact("Card 4242 4242 4242 4242 expires soon.");
  assert.equal(result.count, 1);
  assert.equal(result.findings[0]?.rule, "card");
  assert.equal(result.text, "Card [card#1] expires soon.");
});

test("a Luhn-invalid 16-digit number is not called a card", () => {
  const result = redact("Reference 1234 5678 9012 3456 is not a card.");
  assert.equal(result.findings.some((finding) => finding.rule === "card"), false);
});

test("detects API keys by provider shape", () => {
  const result = redact("Use sk-abcdefghijklmnopqrstuvwx then stop.");
  assert.equal(result.findings[0]?.rule, "api-key");
  assert.ok(!result.text.includes("sk-abc"));
});

test("detects a bearer token", () => {
  const result = redact("Authorization: Bearer abcDEF123._-xyz000 end.");
  assert.equal(result.findings[0]?.rule, "bearer");
  assert.equal(result.text, "Authorization: [bearer#1] end.");
});

test("detects a JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const result = redact(`token ${jwt} end`);
  assert.equal(result.findings[0]?.rule, "jwt");
  assert.ok(!result.text.includes(jwt));
});

test("detects a private key block whole", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nmore\n-----END RSA PRIVATE KEY-----";
  const result = redact(`here:\n${key}\ndone`);
  assert.equal(result.findings[0]?.rule, "private-key");
  assert.ok(!result.text.includes("MIIEowIBAAKCAQEA"));
});

test("detects an IP address but rejects an out-of-range octet", () => {
  assert.equal(redact("host 10.0.0.7 up").findings[0]?.rule, "ipv4");
  assert.equal(redact("version 999.1.1.1 here").findings.length, 0);
});

test("detects a phone number with a leading + or separators", () => {
  assert.equal(redact("call +234 803 123 4567 now").findings[0]?.rule, "phone");
  assert.equal(redact("call 0803-123-4567 now").findings[0]?.rule, "phone");
});

test("a bare integer is not a phone number", () => {
  assert.equal(redact("the year 2026 and id 1234").findings.length, 0);
});

// --- redaction mechanics --------------------------------------------------

test("multiple values get numbered placeholders in order", () => {
  const result = redact("a@b.com and c@d.com");
  assert.equal(result.text, "[email#1] and [email#2]");
  assert.equal(result.findings[0]?.count, 2);
  assert.deepEqual(result.findings[0]?.placeholders, ["[email#1]", "[email#2]"]);
});

test("redaction is deterministic and hashes stably", () => {
  const input = "mail me at a@b.com or +1 555 000 1111";
  const first = redact(input);
  const second = redact(input);
  assert.equal(first.text, second.text);
  assert.equal(first.hash, second.hash);
});

test("a change in the payload changes the hash", () => {
  // Both sanitize to plain text, but the text differs, so the hash must too.
  assert.notEqual(redact("note: blue").hash, redact("note: green").hash);
});

test("isClean reflects whether anything was found", () => {
  assert.equal(isClean(redact("just some ordinary words")), true);
  assert.equal(isClean(redact("a@b.com")), false);
});

test("prepare() runs the same pipeline as redact()", () => {
  const input = "token sk-abcdefghijklmnopqrstuvwx";
  assert.deepEqual(prepare(input), redact(input));
});

// --- consent binding ------------------------------------------------------

function request(overrides: Partial<ConsentRequest> = {}): ConsentRequest {
  return {
    hash: "h1",
    operation: "chat",
    destination: "firebase-ai-logic:gemini-4-hydrogen",
    preview: "hello [email#1]",
    ...overrides,
  };
}

test("no approval means the request is refused", () => {
  assert.deepEqual(checkConsent(null, request()), { ok: false, reason: "no-approval" });
});

test("a matching approval passes", () => {
  const approval = approve(request());
  assert.deepEqual(checkConsent(approval, request()), { ok: true });
});

test("a changed payload invalidates the approval", () => {
  const approval = approve(request());
  assert.deepEqual(checkConsent(approval, request({ hash: "h2" })), {
    ok: false,
    reason: "payload-changed",
  });
});

test("a changed operation invalidates the approval", () => {
  const approval = approve(request());
  assert.deepEqual(checkConsent(approval, request({ operation: "summarize" })), {
    ok: false,
    reason: "operation-changed",
  });
});

test("a changed destination invalidates the approval", () => {
  const approval = approve(request());
  assert.deepEqual(checkConsent(approval, request({ destination: "other:model" })), {
    ok: false,
    reason: "destination-changed",
  });
});

test("approving an empty hash is a sanitization failure", () => {
  assert.throws(() => approve(request({ hash: "" })), SanitizationError);
});

test("ConsentGate refuses to assert without a matching approval", () => {
  const gate = new ConsentGate();
  assert.throws(() => gate.assert(request()), /refused/);
  gate.approve(request());
  assert.doesNotThrow(() => assertConsent(gate.current(), request()));
  assert.throws(() => gate.assert(request({ hash: "different" })), /refused/);
});

test("the gate holds one approval at a time", () => {
  const gate = new ConsentGate();
  gate.approve(request({ hash: "h1" }));
  gate.approve(request({ hash: "h2" }));
  assert.deepEqual(gate.check(request({ hash: "h1" })), { ok: false, reason: "payload-changed" });
  assert.deepEqual(gate.check(request({ hash: "h2" })), { ok: true });
  gate.clear();
  assert.deepEqual(gate.check(request({ hash: "h2" })), { ok: false, reason: "no-approval" });
});

// --- adversarial / malformed input ---------------------------------------

test("odd inputs do not throw and stay sanitized", () => {
  for (const input of ["", "   ", "🙂🙂🙂", "<script>alert(1)</script>", "a".repeat(10_000), "\\\\", "\u0000\u0001"]) {
    assert.doesNotThrow(() => redact(input));
    const result = redact(input);
    assert.equal(typeof result.hash, "string");
    assert.equal(result.hash.length, 64);
  }
});

test("an email-looking string inside a longer token is still caught once", () => {
  const result = redact("contact: <a@b.com>.");
  assert.equal(result.count, 1);
  assert.equal(result.text, "contact: <[email#1]>.");
});
