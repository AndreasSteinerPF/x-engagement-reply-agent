import { normalizeAuthor, type MatchedArticle } from "../ports.js";

/**
 * Threshold gating, mirroring the reference pipeline's two independent gates:
 *  - the *parent task* gate on the best-match raw similarity, and
 *  - the *article recommendation* gate on each article's raw similarity.
 */

/** A matched article qualifies for reply subtasks when its raw score clears the gate. */
export function meetsArticleThreshold(rawScore: number, threshold: number): boolean {
  return rawScore >= threshold;
}

/** The parent task gate. A threshold of 0 means "always allow if other checks pass". */
export function meetsTaskThreshold(bestRawScore: number, threshold: number): boolean {
  return threshold <= 0 || bestRawScore >= threshold;
}

/** Filter matched articles down to those that qualify for recommendation subtasks. */
export function recommendedArticles(articles: MatchedArticle[], threshold: number): MatchedArticle[] {
  return articles.filter((a) => meetsArticleThreshold(a.rawScore, threshold));
}

/** True if this author's own posts must never be tasked (e.g. the corpus author). */
export function isExcludedAuthor(handleOrName: string, excludeList: string[]): boolean {
  const normalized = normalizeAuthor(handleOrName);
  return excludeList.map(normalizeAuthor).includes(normalized);
}
