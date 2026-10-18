/**
 * Profile pictures, cached locally.
 *
 * Instagram's image CDN serves pictures to instagram.com but not to extension
 * pages, and the picture URLs it hands out expire after a few days. So the
 * content script (which runs on instagram.com) fetches each picture once, and
 * the extension keeps it as a data URL keyed by the picture's path, which stays
 * the same while the person keeps the same picture.
 */

/** Profile pictures are about 150x150 JPEGs; anything much larger isn't one. */
export const AVATAR_MAX_BYTES = 256 * 1024;
/** How many pictures one request to an Instagram tab fetches at most. */
export const AVATAR_BATCH = 60;
/** Concurrent picture downloads in the Instagram tab. */
export const AVATAR_CONCURRENCY = 4;

export interface AvatarRecord {
  readonly viewerId: string;
  readonly pk: string;
  /** Path of the picture URL it came from (without the expiring signature). */
  readonly key: string;
  readonly dataUrl: string;
  readonly fetchedAt: number;
}

export interface AvatarRequest {
  readonly pk: string;
  readonly url: string;
}

export interface AvatarResult extends AvatarRequest {
  /** `null` when the picture could not be fetched (expired URL, not an image, too large). */
  readonly dataUrl: string | null;
}

/** Identifies a picture across syncs: the URL path, without the query string that expires. */
export function avatarKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? `${parsed.host}${parsed.pathname}` : null;
  } catch {
    return null;
  }
}

/**
 * Which of `pks` need a fresh download: they have a picture URL, and nothing is
 * cached for it (or the cached one is an older picture). `failed` holds keys
 * that failed recently, so a broken URL isn't retried on every render.
 */
export function avatarsToFetch(
  pks: readonly string[],
  pictureUrl: (pk: string) => string | undefined,
  cached: ReadonlyMap<string, Pick<AvatarRecord, 'key'>>,
  failed: ReadonlySet<string> = new Set(),
): AvatarRequest[] {
  const out: AvatarRequest[] = [];
  for (const pk of new Set(pks)) {
    const url = pictureUrl(pk);
    const key = url ? avatarKey(url) : null;
    if (!url || !key || cached.get(pk)?.key === key || failed.has(key)) {
      continue;
    }
    out.push({ pk, url });
  }
  return out;
}

function toDataUrl(type: string, bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** Downloads one picture as a data URL, or `null` if it isn't a usable image. */
export async function fetchAvatar(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  if (!avatarKey(url)) {
    return null;
  }
  try {
    const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit' });
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!response.ok || !type.startsWith('image/')) {
      return null;
    }
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > 0 && bytes.byteLength <= AVATAR_MAX_BYTES ? toDataUrl(type, bytes) : null;
  } catch {
    return null;
  }
}

/** Downloads pictures a few at a time. */
export async function fetchAvatars(
  fetchImpl: typeof fetch,
  requests: readonly AvatarRequest[],
  concurrency = AVATAR_CONCURRENCY,
): Promise<AvatarResult[]> {
  const results: AvatarResult[] = new Array(requests.length);
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const index = next++;
      const request = requests[index]!;
      results[index] = { ...request, dataUrl: await fetchAvatar(fetchImpl, request.url) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, worker));
  return results;
}
