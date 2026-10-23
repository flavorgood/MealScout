import assert from "node:assert/strict";
import test from "node:test";
import { getOAuthIdentityFailureMessage } from "./oauthIdentityFailure";

test("approved OAuth identity failures have honest user-facing messages", () => {
  assert.match(
    getOAuthIdentityFailureMessage("auth_account_link_required") || "",
    /no accounts were linked or changed/i,
  );
  assert.match(
    getOAuthIdentityFailureMessage("AUTH_IDENTITY_COLLISION") || "",
    /account recovery/i,
  );
  assert.match(
    getOAuthIdentityFailureMessage("auth_account_disabled") || "",
    /contact support/i,
  );
});

test("unknown callback details are not reflected to the person", () => {
  assert.equal(getOAuthIdentityFailureMessage("provider_internal_detail"), null);
  assert.equal(getOAuthIdentityFailureMessage(null), null);
});

const approvedMessages = [
  [
    "auth_account_link_required",
    "That email already belongs to a MealScout account. Sign in with its existing method; no accounts were linked or changed.",
  ],
  [
    "auth_identity_collision",
    "MealScout found conflicting account records. Sign in with your existing method or use account recovery; no accounts were linked or changed.",
  ],
  [
    "auth_account_disabled",
    "This MealScout account is disabled. Use account recovery or contact support; no account was linked or changed.",
  ],
] as const;

for (const [code, message] of approvedMessages) {
  for (const input of [code, code.toUpperCase(), ` \t${code.toUpperCase()}\r\n`]) {
    test(`approved code ${JSON.stringify(input)} preserves its exact message`, () => {
      assert.equal(getOAuthIdentityFailureMessage(input), message);
    });
  }
}

for (const input of [
  "constructor",
  " CONSTRUCTOR ",
  "__proto__",
  " __PROTO__ ",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]) {
  test(`inherited name ${JSON.stringify(input)} is not an approved message`, () => {
    assert.equal(getOAuthIdentityFailureMessage(input), null);
  });
}

for (const input of [
  "",
  " \t\r\n",
  "provider_internal_detail",
  "auth_account_link_required-extra",
  "auth_account_disabled?",
]) {
  test(`unknown string ${JSON.stringify(input)} returns null`, () => {
    assert.equal(getOAuthIdentityFailureMessage(input), null);
  });
}

const nonStringInputs: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["false", false],
  ["true", true],
  ["zero", 0],
  ["number", 1],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["bigint", 42n],
  ["symbol", Symbol("auth_identity_collision")],
  ["empty array", []],
  ["array containing an approved code", ["auth_account_disabled"]],
  ["object", {}],
  ["boxed approved string", new String("auth_identity_collision")],
  ["object without a prototype", Object.create(null)],
];

for (const [label, input] of nonStringInputs) {
  test(`non-string ${label} returns null`, () => {
    assert.equal(getOAuthIdentityFailureMessage(input), null);
  });
}

for (const hook of ["toString", "valueOf", Symbol.toPrimitive] as const) {
  test(`non-string input never invokes ${String(hook)}`, () => {
    let calls = 0;
    const input = {
      toString: () => ({}),
      [hook]: () => {
        calls += 1;
        throw new Error("Callback input must not be coerced");
      },
    };
    assert.equal(getOAuthIdentityFailureMessage(input), null);
    assert.equal(calls, 0);
  });
}
