import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useMemo, useState } from "preact/hooks";
import { RoturDriveClient, claimLinkToken, requestLinkCode } from "./client";

const TOKEN_KEY = "rotur.token";

interface RoturAuth {
  token: string | null;
  /** Set after startLogin(); show this to the user and send them to https://rotur.dev/link */
  pendingCode: string | null;
  drive: RoturDriveClient | null;
  startLogin(): Promise<void>;
  /** Call from the "I've finished authenticating" button. Returns false if not linked yet. */
  finishLogin(): Promise<boolean>;
  logout(): void;
}

const Ctx = createContext<RoturAuth | null>(null);

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function RoturAuthProvider({ children }: { children: ComponentChildren }) {
  const [token, setToken] = useState<string | null>(readToken);
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  const startLogin = useCallback(async () => {
    setPendingCode(await requestLinkCode());
  }, []);

  const finishLogin = useCallback(async () => {
    if (!pendingCode) return false;
    const t = await claimLinkToken(pendingCode);
    if (!t) return false;
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* storage unavailable; keep in memory only */
    }
    setToken(t);
    setPendingCode(null);
    return true;
  }, [pendingCode]);

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setToken(null);
    setPendingCode(null);
  }, []);

  const drive = useMemo(() => (token ? new RoturDriveClient(token) : null), [token]);

  const value = useMemo(
    () => ({ token, pendingCode, drive, startLogin, finishLogin, logout }),
    [token, pendingCode, drive, startLogin, finishLogin, logout]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRotur(): RoturAuth {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRotur must be used inside <RoturAuthProvider>");
  return ctx;
}
