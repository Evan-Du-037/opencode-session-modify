// ID 生成器：复刻 opencode 的 ses_/msg_/prt_ + ULID 格式
// 真实样本: ses_077c1aa9affeCU2YKq9tDf5wnL (前缀 + 26位 ULID)
// ULID = 10位时间(Crockford base32) + 16位随机

const ENCODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function ulidTime(ms: number): string {
  let t = Math.floor(ms)
  let time = ""
  for (let i = 0; i < 10; i++) {
    time = ENCODE[t % 32] + time
    t = Math.floor(t / 32)
  }
  return time
}

function randomBase32(len: number): string {
  let s = ""
  const arr = new Uint8Array(len)
  crypto.getRandomValues(arr)
  for (let i = 0; i < len; i++) s += ENCODE[arr[i] % 32]
  return s
}

function ulid(): string {
  return ulidTime(Date.now()) + randomBase32(16)
}

export function sessionId(): string {
  return "ses_" + ulid()
}

export function messageId(): string {
  return "msg_" + ulid()
}

export function partId(): string {
  return "prt_" + ulid()
}
