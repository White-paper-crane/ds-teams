// 会话与密码（纯函数，零依赖）。2026-11-05 群主拍板：浏览器不再拿成员 key，
// 改成「登录一次 → 不透明会话 cookie」。member key 只留给 CLI / 桥接 / 测试用。
//
// 口径（调研 C 段结论，别改）：
//   - cookie 里放 randomBytes(32) 的 base64url，服务端只存 SHA-256(token)，库泄露也拿不到可用 token；
//   - 踢人/改密码/主动退出 → 删会话即失效，不用等过期；
//   - timingSafeEqual 要求两个 buffer 等长，否则直接抛错，所以先各自 HMAC-SHA256 成 32 字节再比；
//   - 密码用 scrypt + 每人独立 salt，存 { salt, hash }。
import crypto from "node:crypto";

export const COOKIE_NAME = "sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 72;

const HMAC_KEY = "ds-teams/session/2026-11-05";
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** 新会话 token：32 字节随机 → base64url（43 字符，≥256bit）。 */
export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/** 服务端只存这个哈希，不存 token 本身。 */
export function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** 等长比较：先各自 HMAC-SHA256 压成 32 字节，再 timingSafeEqual。 */
export function safeEqual(a, b) {
  const x = crypto.createHmac("sha256", HMAC_KEY).update(String(a)).digest();
  const y = crypto.createHmac("sha256", HMAC_KEY).update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** 设密码：返回 { salt, hash }，可直接塞进 people.json。 */
export function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), s, 32, SCRYPT).toString("hex");
  return { salt: s, hash };
}

export function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  let hash;
  try {
    hash = crypto.scryptSync(String(password), record.salt, 32, SCRYPT).toString("hex");
  } catch {
    return false;
  }
  return safeEqual(hash, record.hash);
}

export function checkPassword(password) {
  const pw = String(password || "");
  if (pw.length < PASSWORD_MIN) return { ok: false, error: `密码至少 ${PASSWORD_MIN} 位` };
  if (pw.length > PASSWORD_MAX) return { ok: false, error: `密码最多 ${PASSWORD_MAX} 位` };
  return { ok: true };
}

/** Cookie 头 → { name: value }。同名取第一个。 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookieHeader(token, ttlMs = SESSION_TTL_MS) {
  const maxAge = Math.floor(ttlMs / 1000);
  // 内网 HTTP 下 Secure / __Host- 会失效，所以不加；SameSite=Lax 挡住跨站 POST。
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function sessionAlive(session, now = Date.now(), ttlMs = SESSION_TTL_MS) {
  if (!session) return false;
  const seen = Number(session.seen || session.at || 0);
  return now - seen < ttlMs;
}

/** 初始注册码：去掉容易看错的 0/O/1/I，10 位，约 50bit，只在主机本地可见。 */
export function newSetupCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 注册码比较（大小写不敏感、忽略空格与连字符）。 */
export function normalizeSetupCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
