import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackAddress } from "../src/auth/loopback.js";

test("OAuth callback accepts IPv4 and IPv6 loopback addresses only", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.10"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});
