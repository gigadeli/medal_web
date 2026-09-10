/**
 * トークンと引き継ぎコードの生成・ハッシュ (DESIGN_SERVER.md §5.2 / §5.3)
 *
 * 生の値は D1 に入れない。入れるのは SHA-256 だけ。
 * D1 が漏れても、そのままでは名乗れないようにする。
 */

/** セッショントークン: 32バイト乱数 = 256bit */
export function newToken(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return base64url(raw);
}

/**
 * 引き継ぎコード: Crockford Base32 の 8 文字 = 40bit (§15-11)。
 *
 * 人が読んで打ち込むので、紛らわしい I / L / O / U を含まない字種を使う。
 * 40bit は 10分・1回限り・404統一なら総当たりに耐えるが、
 * **D1 が漏れた場合は総当たりできる長さ**なので、保存は必ずハッシュで行う。
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newTransferCode(): string {
  const raw = new Uint8Array(8);
  crypto.getRandomValues(raw);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CROCKFORD[raw[i]! & 31];
    if (i === 3) out += '-';        // 表示だけの区切り。照合前に取り除く
  }
  return out;
}

/** 入力のゆらぎ (小文字・区切り・紛らわしい字) を吸収してから照合する */
export function normalizeTransferCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
