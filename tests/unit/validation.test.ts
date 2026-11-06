import { describe, expect, it } from "vitest";
import { signInSchema, signUpSchema } from "@/lib/validation/auth";
import { safeRedirectPath } from "@/lib/redirect";
import { slugify } from "@/lib/utils";

describe("signUpSchema", () => {
  const valid = { name: "Ada", email: "  Ada@Example.COM ", password: "longpassword1", workspaceName: "Ada Co" };

  it("normalizes email", () => {
    expect(signUpSchema.parse(valid).email).toBe("ada@example.com");
  });

  it.each([
    ["short", "short1"],
    ["no number", "longpasswordonly"],
    ["no letter", "12345678901"],
  ])("rejects weak password (%s)", (_label, password) => {
    expect(signUpSchema.safeParse({ ...valid, password }).success).toBe(false);
  });

  it("rejects a bad email and missing workspace", () => {
    const r = signUpSchema.safeParse({ ...valid, email: "nope", workspaceName: "" });
    expect(r.success).toBe(false);
    expect(Object.keys(r.error!.flatten().fieldErrors)).toEqual(expect.arrayContaining(["email", "workspaceName"]));
  });
});

describe("signInSchema", () => {
  it("does not enforce password policy on sign-in", () => {
    expect(signInSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
  });
});

describe("safeRedirectPath", () => {
  it.each([
    ["/dashboard/posts", "/dashboard/posts"],
    ["//evil.com", "/dashboard"],
    ["/\\evil.com", "/dashboard"],
    ["https://evil.com/dashboard", "/dashboard"],
    ["http://localhost:3000/dashboard?x=1", "/dashboard?x=1"],
    ["javascript:alert(1)", "/dashboard"],
    [undefined, "/dashboard"],
  ])("%s → %s", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });
});

describe("slugify", () => {
  it("produces url-safe slugs", () => {
    expect(slugify("  Café Société & Co!! ")).toBe("cafe-societe-co");
  });
});
