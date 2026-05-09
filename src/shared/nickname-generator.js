import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const DEFAULT_NAMES = [
  "快乐猫", "小熊猫", "向日葵", "奶茶", "彩虹", "海豚",
  "棉花糖", "小鹿", "柠檬", "蓝鲸", "樱花", "冰淇淋",
  "小企鹅", "蘑菇", "云朵", "蜜桃", "刺猬", "泡泡"
];

let cachedNicknames = null;

export function loadClientNicknames() {
  if (cachedNicknames) return cachedNicknames;
  try {
    const url = new URL("../../assets/client-nicknames.json", import.meta.url);
    const raw = readFileSync(url, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length >= 10) {
      cachedNicknames = parsed;
      return cachedNicknames;
    }
  } catch {}
  cachedNicknames = DEFAULT_NAMES;
  return cachedNicknames;
}

export function generateNickname(names) {
  const list = names && names.length ? names : loadClientNicknames();
  const noun = list[crypto.randomInt(list.length)];
  const letter = String.fromCharCode(65 + crypto.randomInt(26)); // A-Z
  const num = String(crypto.randomInt(100)).padStart(2, "0");    // 00-99
  return `${noun}-${letter}${num}`;
}
