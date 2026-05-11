import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hmacSha256Hex, sha256Hex } from "../shared/crypto.js";
import { currentBusinessDay } from "./day-context.js";

const DEFAULT_NAMES = [
  "水星", "金星", "地球", "火星", "木星", "土星", "天王星", "海王星", "冥王星",
  "谷神星", "阋神星", "妊神星", "鸟神星",
  "仙女座", "猎户座", "仙后座", "大熊座", "小熊座", "天蝎座", "狮子座",
  "天琴座", "天鹅座", "天鹰座", "英仙座", "飞马座", "双子座", "金牛座", "射手座", "半人马座", "天龙座",
  "船底座", "船帆座", "船尾座", "南十字座",
  "银河系", "仙女座星系", "三角座星系", "大麦哲伦云", "小麦哲伦云",
  "涡状星系", "草帽星系", "风车星系", "向日葵星系", "黑眼星系",
  "猎户座星云", "鹰状星云", "蟹状星云", "环状星云", "礁湖星云", "螺旋星云", "马头星云", "玫瑰星云",
  "昴星团", "毕星团", "M13", "M22", "M78", "M42", "M45", "M31", "M51", "M104",
  "NGC 1277", "NGC 6543", "IC 1101",
  "天狼星", "老人星", "大角星", "织女星", "五车二", "参宿七", "南河三", "参宿四", "牛郎星", "天津四", "心宿二", "角宿一", "北落师门", "北河三", "轩辕十四"
];

export function loadNames(namesPath) {
  if (!namesPath) return DEFAULT_NAMES;
  const resolved = path.resolve(namesPath);
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
    console.warn(`WARNING: ${resolved} is not a valid non-empty string array, using default names`);
    return DEFAULT_NAMES;
  } catch {
    return DEFAULT_NAMES;
  }
}

export function loadOrGenerateSalt(saltPath) {
  const resolved = path.resolve(saltPath);
  try {
    return fs.readFileSync(resolved, "utf8").trim();
  } catch {
    // ignore — file may not exist
  }
  const salt = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, salt + "\n", "utf8");
  return salt;
}

export function todayStr(tz) {
  return new Date().toLocaleDateString("sv-SE", { timeZone: tz || "Asia/Shanghai" });
}

export class BoardAnonymizer {
  constructor(salt, names = DEFAULT_NAMES, businessDaySource = currentBusinessDay) {
    this.salt = salt;
    this.names = names;
    this.businessDayProvider = typeof businessDaySource === "function"
      ? businessDaySource
      : () => todayStr(businessDaySource);
    this._reverseMap = null;
    this._displayNameMap = null;
    this._buildDate = null;
    this._dirty = true;
  }

  businessDay() {
    return this.businessDayProvider();
  }

  getPublicId(participantId) {
    return hmacSha256Hex(this.salt, `${participantId}|${this.businessDay()}`).slice(0, 16);
  }

  _baseName(publicId) {
    const hash = sha256Hex(publicId);
    const nameIndex = Number.parseInt(hash.slice(0, 4), 16) % this.names.length;
    return this.names[nameIndex];
  }

  getDisplayName(publicId) {
    if (this._displayNameMap) return this._displayNameMap.get(publicId) || this._baseName(publicId);
    return this._baseName(publicId);
  }

  buildReverseMap(participantIds) {
    const reverseMap = new Map();
    const displayNameMap = new Map();
    const usedCounts = new Map();
    for (const id of participantIds) {
      const publicId = this.getPublicId(id);
      reverseMap.set(publicId, id);
      const base = this._baseName(publicId);
      const count = (usedCounts.get(base) || 0) + 1;
      usedCounts.set(base, count);
      displayNameMap.set(publicId, count === 1 ? base : `${base} ${count}`);
    }
    this._reverseMap = reverseMap;
    this._displayNameMap = displayNameMap;
    this._buildDate = this.businessDay();
    this._dirty = false;
    return reverseMap;
  }

  get reverseMap() {
    return this._reverseMap;
  }

  get dirty() {
    return this._dirty;
  }

  get stale() {
    return this._buildDate !== null && this._buildDate !== this.businessDay();
  }

  markDirty() {
    this._dirty = true;
  }

  clearCache() {
    this._reverseMap = null;
    this._displayNameMap = null;
    this._buildDate = null;
    this._dirty = true;
  }

  resolveParticipantId(displayId) {
    if (!this._reverseMap) return null;
    return this._reverseMap.get(displayId) || null;
  }
}
