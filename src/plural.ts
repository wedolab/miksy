// Число и слово в нужной форме: 1 файл, 2 файла, 5 файлов (one — для 1, 21…; few — для 2–4, 22…; many — остальное)
export function plural(n: number, one: string, few: string, many: string): string {
  const d = Math.abs(n) % 100, u = d % 10;
  return d >= 11 && d <= 14 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
}
// «5 файлов»
export const count = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;
// Частые слова сообщений
export const files = (n: number) => count(n, "файл", "файла", "файлов");
