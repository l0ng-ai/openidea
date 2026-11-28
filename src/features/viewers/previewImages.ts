import { call, commands } from "@/platform/ipc";

/** Loaded local images by absolute path (data URLs), shared by all previews. */
const imageCache = new Map<string, Promise<string>>();
const IMAGE_CACHE_LIMIT = 64;

export function imageUrl(path: string): Promise<string> {
  let p = imageCache.get(path);
  if (!p) {
    p = call(commands.fsReadImage(path));
    p.catch(() => imageCache.delete(path));
    if (imageCache.size >= IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value!);
    imageCache.set(path, p);
  }
  return p;
}
