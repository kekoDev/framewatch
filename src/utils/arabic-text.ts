import { MAX_ARABIC_INJECTION_LENGTH } from "../constants.js";

/**
 * Arabic stand-in text, matched to the length of what it replaces.
 *
 * `framewatch_rtl` can replace every visible string on a page with Arabic, so
 * that the layout is tested against text that actually renders right-to-left
 * rather than against English sitting inside an RTL container. English in an
 * RTL page is a bidirectional edge case of its own and hides the ordinary
 * bugs: the Latin run keeps its own direction, so a container that never
 * mirrored still *looks* plausible.
 *
 * The length matching is the part that matters. If "Add to cart" became a
 * three-character word, the button would shrink and any overflow the tool
 * reported afterwards would be an artifact of the substitution rather than a
 * property of the page — and if it became a paragraph, every page would
 * overflow. So each replacement is built to within a few characters of the
 * string it replaces, and the report's overflow findings mean what they say.
 *
 * Nothing here touches a browser: it is a string in, a string out, so every
 * case is unit-testable without launching Chromium.
 */

/**
 * The vocabulary, grouped by length so a replacement can be assembled to fit.
 *
 * Real words, not lorem ipsum: an Arabic reader glancing at a screenshot
 * should see a plausible interface, and the shaping/ligature behaviour of real
 * words is what stresses the text rendering. These are the words a UI is
 * actually made of — actions, labels, navigation.
 */
const WORDS: readonly string[] = [
  // 2–4 characters
  "نعم",
  "لا",
  "حسنا",
  "بحث",
  "إغلاق",
  "حفظ",
  "فتح",
  "التالي",
  "السابق",
  "رجوع",
  // 5–8
  "تسجيل",
  "الدخول",
  "الخروج",
  "الرئيسية",
  "المنتجات",
  "الخدمات",
  "الطلبات",
  "الحساب",
  "الإعدادات",
  "المفضلة",
  // 9+
  "أضف إلى السلة",
  "إتمام الشراء",
  "تواصل معنا",
  "من نحن",
  "الشروط والأحكام",
  "سياسة الخصوصية",
  "اشترك في النشرة",
  "عرض جميع النتائج",
];

/** A sentence's worth, for replacing paragraphs rather than labels. */
const SENTENCES: readonly string[] = [
  "مرحبا بك في متجرنا الإلكتروني",
  "نقدم لك أفضل المنتجات بأسعار تنافسية",
  "يمكنك تصفح الأقسام والاطلاع على العروض",
  "خدمة التوصيل متاحة إلى جميع المناطق",
  "فريق الدعم جاهز للإجابة عن أسئلتك",
];

/**
 * Arabic-Indic digits, so a number reads as Arabic too.
 *
 * Kept as a separate mapping rather than being replaced by words: a price, a
 * quantity or a date is still a number in an Arabic interface, and turning
 * "24" into a word would change what the element is rather than what language
 * it is in — which is the opposite of what this substitution is for.
 */
const ARABIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"] as const;

/**
 * Build Arabic text about as long as `original`.
 *
 * `seed` makes the choice deterministic and varied: the same string in the
 * same place gets the same replacement on every run (so two runs of the tool
 * are comparable, and the LTR and RTL passes agree), while two different
 * elements of the same length do not all get the same word.
 *
 * A string that is only digits and punctuation keeps its shape and is merely
 * transliterated — see `ARABIC_DIGITS`.
 */
export function arabicFor(original: string, seed = 0): string {
  const source = String(original ?? "");
  const trimmed = source.trim();
  if (trimmed === "") return source;

  // Numbers, prices, times: keep the shape, change the digits. Replacing
  // "١٢:٣٠" with a word would be a different element, not a translated one.
  if (!/\p{L}/u.test(trimmed)) return toArabicDigits(source);

  const target = Math.min(trimmed.length, MAX_ARABIC_INJECTION_LENGTH);
  const built = target > 24 ? buildSentence(target, seed) : buildPhrase(target, seed);

  // Leading/trailing whitespace is layout — a label may rely on it — so the
  // original's edges are preserved and only the text between them replaced.
  const leading = source.slice(0, source.length - source.trimStart().length);
  const trailing = source.slice(source.trimEnd().length);
  return `${leading}${built}${trailing}`;
}

/**
 * Words joined until they are about `target` characters long.
 *
 * Each step picks the word that gets closest to the remaining space rather
 * than taking the first candidate and giving up when it does not fit. Giving
 * up is the trap: a 19-character string whose first word happens to be 10
 * characters would stop there, nine short, and every button on the page would
 * come back narrower than it really is — which is exactly the measurement
 * error this whole module exists to avoid.
 */
function buildPhrase(target: number, seed: number): string {
  // A starting word no longer than the target, so a 3-character label does
  // not become a 13-character phrase.
  const candidates = WORDS.filter((word) => word.length <= Math.max(3, target));
  const pool = candidates.length > 0 ? candidates : WORDS;

  let out = pool[hash(seed) % pool.length];
  let step = 1;
  while (out.length < target - 1 && step <= 40) {
    const remaining = target - out.length - 1;
    const next = bestFit(pool, remaining, seed + step);
    // Nothing left in the vocabulary fits the gap: stop rather than overshoot.
    if (next === null) break;
    out = `${out} ${next}`;
    step += 1;
  }
  return out;
}

/**
 * The word closest to `remaining` characters without overshooting by more
 * than a hair, chosen deterministically among equally good candidates.
 */
function bestFit(pool: readonly string[], remaining: number, seed: number): string | null {
  if (remaining <= 0) return null;
  // A slight overshoot is better than a large undershoot: landing two
  // characters long is invisible, landing nine short is a different layout.
  const fitting = pool.filter((word) => word.length <= remaining + 2);
  if (fitting.length === 0) return null;

  let best = fitting[0].length;
  for (const word of fitting) {
    if (Math.abs(word.length - remaining) < Math.abs(best - remaining)) best = word.length;
  }
  const closest = fitting.filter((word) => word.length === best);
  return closest[hash(seed) % closest.length];
}

/** Sentences joined until they are about `target` characters long. */
function buildSentence(target: number, seed: number): string {
  let out = SENTENCES[hash(seed) % SENTENCES.length];
  let step = 1;
  while (out.length < target - 4) {
    const next = SENTENCES[hash(seed + step) % SENTENCES.length];
    if (out.length + 2 + next.length > target + 8) {
      // No whole sentence fits the remainder; pad with words instead of
      // overshooting, so a long paragraph still lands near its original length.
      const filler = buildPhrase(target - out.length - 1, seed + step);
      out = `${out}، ${filler}`;
      break;
    }
    out = `${out}، ${next}`;
    step += 1;
    if (step > 40) break;
  }
  return out;
}

/** Latin digits to Arabic-Indic, leaving everything else alone. */
export function toArabicDigits(value: string): string {
  return String(value ?? "").replace(/[0-9]/g, (digit) => ARABIC_DIGITS[Number(digit)]);
}

/**
 * A small deterministic hash.
 *
 * Not for security — for repeatability. `Math.random()` would make two runs of
 * the same audit disagree about which element overflowed, which is exactly the
 * kind of flakiness that makes a testing tool untrusted.
 */
function hash(seed: number): number {
  let value = (seed | 0) + 0x9e3779b9;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return Math.abs(value ^ (value >>> 15));
}
