const API = "https://api.rotur.dev";

export class RoturApiError extends Error {
  constructor(public status: number, body: string) {
    super(`http ${status}: ${body}`);
  }
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) throw new RoturApiError(res.status, await res.text());
  return res;
}

/* ------------------------------------------------------------------ */
/* Auth: link-code flow (https://docs.rotur.dev/assorted-apis/linking) */
/* ------------------------------------------------------------------ */

/** Step 1: get a 6-letter code. Show it to the user and send them to https://rotur.dev/link */
export async function requestLinkCode(): Promise<string> {
  const res = await ensureOk(await fetch(`${API}/link/code`));
  const body = (await res.json()) as { code: string };
  return body.code;
}

/**
 * Step 2: call after the user says "I've finished authenticating".
 * Returns the rotur token, or null if they haven't completed the link yet (404).
 */
export async function claimLinkToken(code: string): Promise<string | null> {
  const res = await fetch(`${API}/link/user?code=${encodeURIComponent(code)}`);
  if (res.status === 404) return null;
  await ensureOk(res);
  const body = (await res.json()) as { linked: boolean; token: string };
  return body.linked ? body.token : null;
}

/* ------------------------------------------------------------------ */
/* originFS / roturDrive (github.com/RoturTW/originFSKit README)       */
/* ------------------------------------------------------------------ */

/** Raw entry is a 14-element array; these are the documented 0-based positions. */
const IDX = {
  type: 0,
  name: 1,
  location: 2,
  data: 3,
  created: 8,
  edited: 9,
  size: 11,
  uuid: 13,
} as const;

export interface DriveFile {
  uuid: string;
  type: string; // e.g. ".txt"
  name: string;
  location: string;
  data: string;
  created: number; // unix ms
  edited: number; // unix ms
  size: number;
}

export interface DriveListing {
  name: string;
  path: string; // full index path
  uuid: string;
  /** Heuristic: true if other index paths live beneath this one. */
  isDir: boolean;
}

/** Commands from the README. Payload fields beyond command/uuid are not confirmed yet. */
export interface UpdateChange {
  command: "UUIDa" | "UUIDr" | "UUIDd";
  uuid: string;
  [extra: string]: unknown;
}

function parseEntry(raw: unknown[]): DriveFile {
  return {
    uuid: String(raw[IDX.uuid] ?? ""),
    type: String(raw[IDX.type] ?? ""),
    name: String(raw[IDX.name] ?? ""),
    location: String(raw[IDX.location] ?? ""),
    data: String(raw[IDX.data] ?? ""),
    created: Number(raw[IDX.created] ?? 0),
    edited: Number(raw[IDX.edited] ?? 0),
    size: Number(raw[IDX.size] ?? 0),
  };
}

export class RoturDriveClient {
  private index: Record<string, string> | null = null;
  private root: string | null = null;

  constructor(private token: string) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const q = new URLSearchParams({ auth: this.token, ...params });
    return `${API}${path}?${q}`;
  }

  /** Full path -> UUID map. Cached until `force` is set. */
  async loadIndex(force = false): Promise<Record<string, string>> {
    if (this.index && !force) return this.index;
    const res = await ensureOk(await fetch(this.url("/files/path-index")));
    const body = (await res.json()) as { index: Record<string, string> };
    this.index = body.index;
    // Keys look like "origin/(c) users/{username}/path/to/file.txt"
    const first = Object.keys(this.index).find((k) =>
      /^origin\/\(c\) users\/[^/]+\//.test(k)
    );
    this.root = first ? first.split("/").slice(0, 3).join("/") : null;
    return this.index;
  }

  /** Immediate children of a folder, given a path relative to the user's root ("" = root). */
  async list(dir = ""): Promise<DriveListing[]> {
    const index = await this.loadIndex();
    if (!this.root) return [];
    const base = dir ? `${this.root}/${dir.replace(/^\/|\/$/g, "")}/` : `${this.root}/`;
    const seen = new Map<string, DriveListing>();

    for (const [path, uuid] of Object.entries(index)) {
      if (!path.startsWith(base)) continue;
      const rest = path.slice(base.length);
      if (!rest) continue;
      const [name, ...deeper] = rest.split("/");
      const childPath = base + name;
      const existing = seen.get(name);
      if (existing) {
        if (deeper.length) existing.isDir = true;
      } else {
        seen.set(name, {
          name,
          path: childPath,
          uuid: deeper.length ? (index[childPath] ?? "") : uuid,
          isDir: deeper.length > 0,
        });
      }
    }
    return [...seen.values()].sort(
      (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)
    );
  }

  async getByUuid(uuid: string): Promise<DriveFile> {
    const res = await ensureOk(await fetch(this.url("/files/by-uuid", { uuid })));
    return parseEntry((await res.json()) as unknown[]);
  }

  /** Read a file by its path relative to the user's root. */
  async readFile(relPath: string): Promise<DriveFile> {
    const index = await this.loadIndex();
    if (!this.root) throw new Error("Drive is empty or index has no user root");
    const uuid = index[`${this.root}/${relPath.replace(/^\//, "")}`];
    if (!uuid) throw new Error(`No such file: ${relPath}`);
    return this.getByUuid(uuid);
  }

  /**
   * POST /files with a batch of changes. The README documents the command names and
   * says UUIDr uses 1-based field indices (name = 2, data = 4, ...), but I haven't
   * seen the exact per-command payloads, so build these by hand for now.
   */
  async commit(updates: UpdateChange[]): Promise<void> {
    await ensureOk(
      await fetch(this.url("/files"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      })
    );
    this.index = null; // invalidate cache
  }
}
