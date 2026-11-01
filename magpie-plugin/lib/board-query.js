
import { sha256Hex } from "./atl.js";

// The board's own avatar palette (src/backend/server.js colorFromId): the
// alias chip wears the same color this participant has on the public board.
const AVATAR_COLORS = ["#1c7c54", "#ba3b46", "#006d77", "#8f5f00", "#3d5a80", "#7b2cbf"];

// One board query the page's strip rides on: after a sync, ask the server
// for this participant's standing profile — all-time rank + persistence
// stats (streak / active days / peak day). One call replaces the old
// analytics fetch and carries richer data. The page sandbox has no network,
// so the answer travels through status.js as a snapshot; failures must
// never fail the sync itself (doc/page-content-design.md §3.3).
export async function fetchBoardProfile({ apiBaseUrl, displayId, timeoutMs = 5000 } = {}) {
  if (!apiBaseUrl || !displayId) throw new Error("fetchBoardProfile requires apiBaseUrl and displayId");
  const base = apiBaseUrl.replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(
      `${base}/api/board/profile/${encodeURIComponent(displayId)}`,
      { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } }
    );
  } catch (error) {
    throw new Error(`board unreachable (${error.name || "error"})`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("board needs sign-in on this server");
  }
  if (response.status === 404) throw new Error("participant not found on board");
  if (!response.ok) throw new Error(`board answered HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("board answered non-JSON");
  }
  if (!body || typeof body !== "object" || !Number.isFinite(Number(body.rank))) {
    throw new Error("board answer has no rank");
  }
  const peak = body.peakDay && Number.isFinite(Number(body.peakDay.totalTokens)) ? body.peakDay : null;
  return {
    rank: Number(body.rank),
    currentStreak: Number(body.currentStreak) || 0,
    activeDays: Number(body.activeDays) || 0,
    peakDay: peak ? { day: String(peak.day || ""), totalTokens: Number(peak.totalTokens) } : null,
    fetchedAt: new Date().toISOString(),
    error: null
  };
}

// The anonymous board's daily display name (ATL: /api/board/my-identity).
// Public boards answer {identityMode:"public"} — no name to show; anonymous
// boards answer {identityMode:"anonymous", publicId, displayName}. The name
// ROTATES DAILY server-side, so this rides every sync's snapshot refresh.
export async function fetchMyIdentity({ apiBaseUrl, participantId, timeoutMs = 5000 } = {}) {
  if (!apiBaseUrl || !participantId) throw new Error("fetchMyIdentity requires apiBaseUrl and participantId");
  const base = apiBaseUrl.replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(
      `${base}/api/board/my-identity?participantId=${encodeURIComponent(participantId)}`,
      { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } }
    );
  } catch (error) {
    throw new Error(`identity endpoint unreachable (${error.name || "error"})`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("identity endpoint needs sign-in on this server");
  }
  if (!response.ok) throw new Error(`identity endpoint answered HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("identity endpoint answered non-JSON");
  }
  if (!body || typeof body !== "object" || typeof body.identityMode !== "string") {
    throw new Error("identity endpoint answer has no identityMode");
  }
  // public boards carry no name: the page hides the alias slot entirely
  if (body.identityMode !== "anonymous" || typeof body.displayName !== "string" || !body.displayName) {
    return { identityMode: "public", displayName: "", fetchedAt: new Date().toISOString() };
  }
  const publicId = typeof body.publicId === "string" ? body.publicId : "";
  return {
    identityMode: "anonymous",
    publicId,
    displayName: body.displayName,
    avatarColor: AVATAR_COLORS[Number.parseInt(sha256Hex(publicId).slice(0, 2), 16) % AVATAR_COLORS.length],
    businessDay: typeof body.businessDay === "string" ? body.businessDay : "",
    fetchedAt: new Date().toISOString()
  };
}
