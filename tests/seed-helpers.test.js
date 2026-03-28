import { describe, it, expect } from "vitest";
import { esc, boolToInt, intOrNull } from "../scripts/seed-d1.js";

describe("esc (SQL string escaping)", () => {
  it("returns NULL for null", () => {
    expect(esc(null)).toBe("NULL");
  });

  it("returns NULL for undefined", () => {
    expect(esc(undefined)).toBe("NULL");
  });

  it("wraps strings in single quotes", () => {
    expect(esc("hello")).toBe("'hello'");
  });

  it("escapes single quotes by doubling them", () => {
    expect(esc("it's")).toBe("'it''s'");
  });

  it("handles strings with multiple single quotes", () => {
    expect(esc("it's a 'test'")).toBe("'it''s a ''test'''");
  });

  it("converts numbers to quoted strings", () => {
    expect(esc(42)).toBe("'42'");
  });

  it("handles empty string", () => {
    expect(esc("")).toBe("''");
  });

  it("handles strings with special characters", () => {
    expect(esc("line1\nline2")).toBe("'line1\nline2'");
  });
});

describe("boolToInt", () => {
  it("returns '1' for true", () => {
    expect(boolToInt(true)).toBe("1");
  });

  it("returns '0' for false", () => {
    expect(boolToInt(false)).toBe("0");
  });

  it("returns 'NULL' for null", () => {
    expect(boolToInt(null)).toBe("NULL");
  });

  it("returns 'NULL' for undefined", () => {
    expect(boolToInt(undefined)).toBe("NULL");
  });

  it("returns 'NULL' for non-boolean values", () => {
    expect(boolToInt(0)).toBe("NULL");
    expect(boolToInt(1)).toBe("NULL");
    expect(boolToInt("true")).toBe("NULL");
  });
});

describe("intOrNull", () => {
  it("returns NULL for null", () => {
    expect(intOrNull(null)).toBe("NULL");
  });

  it("returns NULL for undefined", () => {
    expect(intOrNull(undefined)).toBe("NULL");
  });

  it("parses integer values", () => {
    expect(intOrNull(42)).toBe("42");
    expect(intOrNull(0)).toBe("0");
    expect(intOrNull(-5)).toBe("-5");
  });

  it("parses string integers", () => {
    expect(intOrNull("2020")).toBe("2020");
    expect(intOrNull("0")).toBe("0");
  });

  it("returns NULL for non-numeric strings", () => {
    expect(intOrNull("abc")).toBe("NULL");
    expect(intOrNull("")).toBe("NULL");
  });

  it("truncates floats to integers", () => {
    expect(intOrNull(3.14)).toBe("3");
    expect(intOrNull("3.14")).toBe("3");
  });

  it("returns NULL for NaN", () => {
    expect(intOrNull(NaN)).toBe("NULL");
  });
});
