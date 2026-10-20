import { useEffect, useRef, useState } from 'preact/hooks';
import { AVATAR_BATCH } from '../../lib/avatars';
import { sendToBackground } from '../../lib/messages';

/**
 * Loads pictures for the accounts on screen. The background answers from its
 * cache and fetches new or changed pictures through an Instagram tab.
 */
export function useAvatars(viewerId: string | null, pks: readonly string[]): ReadonlyMap<string, string> {
  const [avatars, setAvatars] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  const key = pks.join(',');

  useEffect(() => {
    asked.current = new Set();
    setAvatars(new Map());
  }, [viewerId]);

  useEffect(() => {
    if (!viewerId) {
      return;
    }
    const missing = pks.filter(pk => !asked.current.has(pk));
    if (missing.length === 0) {
      return;
    }
    missing.forEach(pk => asked.current.add(pk));
    const answered = new Set<string>();
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < missing.length && !cancelled; i += AVATAR_BATCH) {
        const chunk = missing.slice(i, i + AVATAR_BATCH);
        const loaded = await sendToBackground<Record<string, string>>({
          type: 'avatars:load',
          viewerId,
          pks: chunk,
        }).catch(() => ({}) as Record<string, string>);
        if (cancelled) {
          return;
        }
        // Pictures that didn't come back (no Instagram tab yet) are asked for again on a later render.
        chunk.forEach(pk => (pk in loaded ? answered.add(pk) : asked.current.delete(pk)));
        if (Object.keys(loaded).length > 0) {
          setAvatars(previous => new Map([...previous, ...Object.entries(loaded)]));
        }
      }
    })();
    return () => {
      cancelled = true;
      missing.filter(pk => !answered.has(pk)).forEach(pk => asked.current.delete(pk));
    };
  }, [viewerId, key]);

  return avatars;
}
