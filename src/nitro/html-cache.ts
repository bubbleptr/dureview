import type { NitroAppPlugin } from "nitro/types";

/**
 * Nitro's `/assets/**` route rule sets `Cache-Control: public, max-age=31536000, immutable`
 * in a `finally` block, after the handler. A missing hashed file falls through to the
 * HTML shell, so that rule would cache the document. HTML stays `no-store`. Real
 * `/assets` files are `text/css` or `text/javascript` and keep the immutable header.
 */
const htmlCachePlugin: NitroAppPlugin = (nitroApp) => {
  nitroApp.hooks.hook("response", (response) => {
    const type = response.headers.get("content-type") ?? "";
    if (!type.trim().toLowerCase().startsWith("text/html")) return;
    response.headers.set("cache-control", "no-store");
  });
};

export default htmlCachePlugin;
