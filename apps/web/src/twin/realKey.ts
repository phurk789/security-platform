// Google Maps key for photorealistic site tiles (build-time env). Kept apart from realTiles.ts so
// builds without a key never load the tiles library.
export const GOOGLE_KEY: string = ((import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '').trim();

export function realTilesAvailable() {
  return !!GOOGLE_KEY;
}
