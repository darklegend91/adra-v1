/**
 * Multilingual normalisation for parsed documents.
 *
 * Pipeline:
 *   1. Detect language with fastText (917 KB, ~1 ms).
 *   2. If non-English Indic language detected, translate to English
 *      via IndicTrans2 distilled (covers all 22 Indian scheduled languages).
 *   3. Return an augmented parsed object with English text so the
 *      downstream nlpExtractor pipeline runs in a single language.
 *
 * Degrades gracefully when the sidecar is unavailable — returns the
 * original parsed object unchanged.
 */

import {
  isSidecarAvailable,
  sidecarDetectLang,
  sidecarTranslate,
} from "./sidecarClient.js";

const MIN_TEXT_LENGTH = 30;   // skip detection for very short documents

export async function normalizeToEnglish(parsed) {
  const text = parsed.text ?? "";

  if (!isSidecarAvailable() || text.length < MIN_TEXT_LENGTH) {
    return { normalizedParsed: parsed, langInfo: _noOp("en") };
  }

  try {
    const detection = await sidecarDetectLang(text);

    if (detection.is_english) {
      return { normalizedParsed: parsed, langInfo: { ...detection, was_translated: false } };
    }

    const translation = await sidecarTranslate(text, detection.lang);

    const normalizedParsed = {
      ...parsed,
      text: translation.translated || text,
      originalText: text,
      detectedLang: detection.lang,
      langConfidence: detection.confidence,
      wasTranslated: translation.was_translated,
    };

    return {
      normalizedParsed,
      langInfo: {
        lang: detection.lang,
        confidence: detection.confidence,
        is_indic: detection.is_indic,
        was_translated: translation.was_translated,
      },
    };
  } catch (err) {
    console.warn("[LanguageNormalizer]", err.message);
    return { normalizedParsed: parsed, langInfo: _noOp("unknown") };
  }
}

function _noOp(lang) {
  return { lang, confidence: 1, was_translated: false, is_indic: false };
}
