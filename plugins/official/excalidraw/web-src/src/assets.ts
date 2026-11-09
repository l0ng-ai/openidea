/**
 * Excalidraw loads its fonts from `EXCALIDRAW_ASSET_PATH` (else from a CDN,
 * which the frame can't reach): the page's own directory, where the build
 * copies them. Imported before Excalidraw.
 */
window.EXCALIDRAW_ASSET_PATH = new URL("./", window.location.href).href;
