import { describe, expect, it } from "vitest";
import { arabicFor, toArabicDigits } from "../src/utils/arabic-text.js";
import { MAX_ARABIC_INJECTION_LENGTH } from "../src/constants.js";

/** Does this string contain Arabic script? */
const isArabic = (value: string): boolean => /[؀-ۿ]/.test(value);

describe("arabicFor — length matching", () => {
  it("produces Arabic of roughly the length it replaces", () => {
    // The whole reason for length matching: an overflow finding has to be a
    // property of the layout, not of the substitution. A replacement that is
    // twice as long would overflow every page; one half as long would hide
    // real overflow.
    for (const original of ["Add to cart", "Sign in", "Home", "Checkout now please", "OK"]) {
      const arabic = arabicFor(original);
      expect(isArabic(arabic)).toBe(true);
      // Within a few characters either way — Arabic words do not come in
      // every length, so exactness is neither possible nor needed.
      expect(Math.abs(arabic.length - original.length)).toBeLessThanOrEqual(4);
    }
  });

  it("does not turn a short label into a long phrase", () => {
    const arabic = arabicFor("OK");
    expect(arabic.length).toBeLessThanOrEqual(6);
  });

  it("builds sentences for text long enough to need them", () => {
    const original = "Welcome to our store, where you can browse products and place an order today";
    const arabic = arabicFor(original);
    expect(isArabic(arabic)).toBe(true);
    expect(Math.abs(arabic.length - original.length)).toBeLessThanOrEqual(12);
  });

  it("never exceeds the injection cap, however long the original", () => {
    const arabic = arabicFor("x".repeat(5000));
    expect(arabic.length).toBeLessThanOrEqual(MAX_ARABIC_INJECTION_LENGTH + 12);
  });
});

describe("arabicFor — what it leaves alone", () => {
  it("keeps whitespace-only strings exactly as they are", () => {
    // Whitespace between inline elements is layout; replacing it would change
    // the spacing and invent overflow.
    expect(arabicFor("   ")).toBe("   ");
    expect(arabicFor("\n  ")).toBe("\n  ");
  });

  it("preserves leading and trailing whitespace around real text", () => {
    const arabic = arabicFor("  Save  ");
    expect(arabic.startsWith("  ")).toBe(true);
    expect(arabic.endsWith("  ")).toBe(true);
  });

  it("transliterates numbers rather than replacing them with words", () => {
    // A price is still a number in an Arabic interface. Turning "24.99" into
    // a word would change what the element is, not what language it is in.
    const arabic = arabicFor("24.99");
    expect(arabic).toBe("٢٤.٩٩");
  });

  it("keeps the shape of a time or a date", () => {
    expect(arabicFor("12:30")).toBe("١٢:٣٠");
  });
});

describe("arabicFor — determinism", () => {
  it("gives the same answer for the same input every time", () => {
    // Two runs of the audit have to agree about which element overflowed;
    // Math.random() here would make the tool flaky and therefore untrusted.
    expect(arabicFor("Add to cart", 7)).toBe(arabicFor("Add to cart", 7));
  });

  it("varies with the seed, so a page is not one word repeated", () => {
    const seeds = [0, 1, 2, 3, 4, 5].map((seed) => arabicFor("Products", seed));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

describe("toArabicDigits", () => {
  it("maps every Latin digit and leaves the rest alone", () => {
    expect(toArabicDigits("0123456789")).toBe("٠١٢٣٤٥٦٧٨٩");
    expect(toArabicDigits("SKU-42/A")).toBe("SKU-٤٢/A");
  });
});
