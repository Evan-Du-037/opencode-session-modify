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

let lastTime = 0;
function ulid(_id: number): string {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return ulidTime(lastTime) + randomBase32(16)
}

export function sessionId(id: number): string {
  return "ses_" + ulid(id)
}

export function messageId(id: number): string {
  return "msg_" + ulid(id)
}

export function partId(id: number): string {
  return "prt_" + ulid(id)
}
