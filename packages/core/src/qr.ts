import qrcode from "qrcode-generator";

const MARGIN = 4;

/** 不含静区的二维码模块矩阵；每行是长度为 size 的 "0"/"1" 字符串，"1" 为深色。 */
export function encodeQrModules(url: string): { size: number; rows: string[] } {
  const qr = qrcode(0, "L");
  qr.addData(url, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  const rows: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let line = "";
    for (let column = 0; column < size; column += 1) line += qr.isDark(row, column) ? "1" : "0";
    rows.push(line);
  }
  return { size, rows };
}

export function encodeQrLines(url: string): { lines: string[]; width: number } {
  const { size, rows } = encodeQrModules(url);
  const width = size + MARGIN * 2;
  const dark = (row: number, column: number) => rows[row - MARGIN]?.[column - MARGIN] === "1";
  const lines: string[] = [];
  for (let row = 0; row < width; row += 2) {
    let line = "\x1b[0;30;47m";
    for (let column = 0; column < width; column += 1) {
      const top = dark(row, column);
      const bottom = dark(row + 1, column);
      line += top ? (bottom ? "█" : "▀") : (bottom ? "▄" : " ");
    }
    lines.push(`${line}\x1b[0m`);
  }
  return { lines, width };
}
