/**
 * EscPosEncoder – ESC/POS command builder.
 * Pure JavaScript, no external dependencies.
 * Supports: text, line feeds, alignment, bold/underline,
 *           item rows, cut, QR code, barcode.
 */

const ESC  = 0x1B;
const GS   = 0x1D;
const LF   = 0x0A;
const CR   = 0x0D;
const NUL  = 0x00;

export class EscPosEncoder {
  constructor() {
    this._buffer = [];
    this._codepage = 'cp437';
  }

  // ─── Raw bytes ──────────────────────────────────────────────
  _push(...bytes) {
    this._buffer.push(...bytes);
    return this;
  }

  _pushString(str) {
    for (let i = 0; i < str.length; i++) {
      this._buffer.push(str.charCodeAt(i) & 0xFF);
    }
    return this;
  }

  // ─── Init ────────────────────────────────────────────────────
  initialize() {
    return this._push(ESC, 0x40); // ESC @
  }

  // ─── Line Feed ───────────────────────────────────────────────
  newline(count = 1) {
    for (let i = 0; i < count; i++) this._push(LF);
    return this;
  }

  // ─── Alignment ───────────────────────────────────────────────
  align(direction) {
    const map = { left: 0, center: 1, right: 2 };
    return this._push(ESC, 0x61, map[direction] ?? 0);
  }

  // ─── Bold ────────────────────────────────────────────────────
  bold(on = true) {
    return this._push(ESC, 0x45, on ? 1 : 0);
  }

  // ─── Underline ───────────────────────────────────────────────
  underline(on = true) {
    return this._push(ESC, 0x2D, on ? 1 : 0);
  }

  // ─── Font size (1x–8x) ───────────────────────────────────────
  size(width = 1, height = 1) {
    const w = Math.min(Math.max(width,  1), 8) - 1;
    const h = Math.min(Math.max(height, 1), 8) - 1;
    return this._push(GS, 0x21, (w << 4) | h);
  }

  // ─── Text ────────────────────────────────────────────────────
  text(str) {
    return this._pushString(str);
  }

  // ─── Line (full text line + LF) ──────────────────────────────
  line(str) {
    return this._pushString(str)._push(LF);
  }

  // ─── Separator ───────────────────────────────────────────────
  rule(char = '-', width = 32) {
    return this.line(char.repeat(width));
  }

  // ─── Item row: left-aligned name, right-aligned price ────────
  item(name, price, width = 32) {
    const priceStr = String(price);
    const nameWidth = width - priceStr.length - 1;
    const truncated = name.length > nameWidth
      ? name.slice(0, nameWidth - 1) + '\u2026'
      : name;
    const row = truncated.padEnd(nameWidth) + ' ' + priceStr;
    return this.line(row);
  }

  // ─── Two-column row ──────────────────────────────────────────
  columns(left, right, width = 32) {
    const rightStr = String(right);
    const leftWidth = width - rightStr.length;
    const leftStr = String(left).slice(0, leftWidth).padEnd(leftWidth);
    return this.line(leftStr + rightStr);
  }

  // ─── QR Code ─────────────────────────────────────────────────
  qrcode(data, size = 6) {
    const bytes = [];
    for (let i = 0; i < data.length; i++) bytes.push(data.charCodeAt(i));
    const len = bytes.length + 3;
    const pL = len & 0xFF;
    const pH = (len >> 8) & 0xFF;
    // Model 2, size, error level M, store, print
    this._push(GS, 0x28, 0x6B, 4, 0, 0x31, 0x41, 0x32, 0x00); // model
    this._push(GS, 0x28, 0x6B, 3, 0, 0x31, 0x43, size);       // size
    this._push(GS, 0x28, 0x6B, 3, 0, 0x31, 0x45, 0x30);       // error level M
    this._push(GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30, ...bytes); // store
    this._push(GS, 0x28, 0x6B, 3, 0, 0x31, 0x51, 0x30);       // print
    return this;
  }

  // ─── Barcode (Code128) ────────────────────────────────────────
  barcode(data, height = 50) {
    const bytes = [];
    for (let i = 0; i < data.length; i++) bytes.push(data.charCodeAt(i));
    this._push(GS, 0x68, height);        // height
    this._push(GS, 0x77, 2);             // width multiplier
    this._push(GS, 0x48, 2);             // HRI below
    this._push(GS, 0x6B, 0x49, bytes.length, ...bytes); // Code128
    return this;
  }

  // ─── Cut ─────────────────────────────────────────────────────
  cut(partial = false) {
    return this._push(GS, 0x56, partial ? 0x01 : 0x00);
  }

  // ─── Cash drawer ─────────────────────────────────────────────
  cashDrawer(pin = 0) {
    return this._push(ESC, 0x70, pin === 0 ? 0x00 : 0x01, 0x19, 0xFA);
  }

  // ─── Encode & return Uint8Array ───────────────────────────────
  encode() {
    return new Uint8Array(this._buffer);
  }
}

/**
 * Build a complete receipt from a structured payload.
 * @param {ReceiptPayload} payload
 * @returns {Uint8Array}
 */
export function buildReceipt(payload) {
  const {
    header   = {},
    items    = [],
    subtotal,
    discount = 0,
    tax      = 0,
    total    = 0,
    payment  = {},
    footer   = '',
    qr       = null,
    width    = 32,
  } = payload;

  const enc = new EscPosEncoder();
  const W   = width;

  enc.initialize();

  // ── Header ──────────────────────────────────────────────────
  if (header.title) {
    enc.align('center').bold(true).size(2, 2).line(header.title).size(1, 1).bold(false);
  }
  if (header.subtitle) enc.align('center').line(header.subtitle);
  if (header.address)  enc.align('center').line(header.address);
  if (header.phone)    enc.align('center').line('Tel: ' + header.phone);
  enc.newline();

  // ── Metadata ────────────────────────────────────────────────
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID');
  const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  enc.align('left');
  enc.columns('Tanggal :', dateStr, W);
  enc.columns('Waktu   :', timeStr, W);
  if (header.receipt_no) enc.columns('No. Struk:', '#' + header.receipt_no, W);
  if (header.cashier)    enc.columns('Kasir    :', header.cashier, W);

  // ── Items ───────────────────────────────────────────────────
  enc.rule('-', W);
  enc.bold(true).columns('Item', 'Total', W).bold(false);
  enc.rule('-', W);

  for (const item of items) {
    const lineTotal = item.qty * item.price;
    enc.item(item.name, formatRupiah(lineTotal), W);
    if (item.qty > 1) {
      enc.align('left').line(`  ${item.qty} x ${formatRupiah(item.price)}`);
    }
  }

  enc.rule('=', W);

  // ── Totals ──────────────────────────────────────────────────
  if (subtotal !== undefined && subtotal !== total) {
    enc.columns('Subtotal', formatRupiah(subtotal), W);
  }
  if (discount > 0) {
    enc.columns('Diskon', '-' + formatRupiah(discount), W);
  }
  if (tax > 0) {
    enc.columns('Pajak', formatRupiah(tax), W);
  }
  enc.bold(true).columns('TOTAL', formatRupiah(total), W).bold(false);
  enc.rule('-', W);

  // ── Payment ─────────────────────────────────────────────────
  if (payment.method) enc.columns('Bayar (' + payment.method + ')', formatRupiah(payment.amount ?? total), W);
  if (payment.change !== undefined && payment.change >= 0) {
    enc.columns('Kembalian', formatRupiah(payment.change), W);
  }

  enc.newline();

  // ── QR Code ─────────────────────────────────────────────────
  if (qr) {
    enc.align('center').qrcode(qr).newline();
  }

  // ── Footer ──────────────────────────────────────────────────
  if (footer) {
    enc.align('center').newline().line(footer);
  }

  enc.newline(3).cut();
  return enc.encode();
}

function formatRupiah(amount) {
  return 'Rp' + Number(amount).toLocaleString('id-ID');
}
