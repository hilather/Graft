/** Perl test/support files are identified only after shared source
 * classification. Directory names alone cannot turn another language into Perl. */
export function isPerlTestPath(path: string, language?: string): boolean {
  return language === "perl" && (/(^|\/)(t|xt)\//i.test(path) || /\.t$/i.test(path));
}
