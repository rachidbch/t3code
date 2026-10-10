const KEY = "t3:pairing-return-path";
export function safePairingReturnPath(path: string | null) {
  return path &&
    /^\/[a-zA-Z0-9_%:-]{1,1536}\/[a-zA-Z0-9_%:-]{1,1536}$/.test(path) &&
    !["/pair", "/connect", "/connect-agent"].includes(path)
    ? path
    : "/";
}
export function rememberPairingReturnPath(path: string) {
  const safe = safePairingReturnPath(path);
  if (safe !== "/")
    try {
      sessionStorage.setItem(KEY, safe);
    } catch {
      /* Storage is optional. */
    }
}
export function takePairingReturnPath() {
  try {
    const path = safePairingReturnPath(sessionStorage.getItem(KEY));
    sessionStorage.removeItem(KEY);
    return path;
  } catch {
    return "/";
  }
}
