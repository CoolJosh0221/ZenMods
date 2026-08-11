// ==UserScript==
// @name           TabPreviewEnhanced native color bridge
// @description    Bridges Zen's scoped toolbar background into Firefox tab-preview popups.
// @author         CoolJosh0221 / OpenAI
// @version        1.0.0
// @include        chrome://browser/content/browser.xhtml
// @grant          none
// ==/UserScript==

(() => {
  "use strict";

  const LOG = "[TabPreviewEnhanced]";
  const PANEL_ID = "tab-preview-panel";
  const BG_IMAGE_VAR = "--tpe-native-background-image";
  const BG_COLOR_VAR = "--tpe-native-background-color";
  const FG_VAR = "--tpe-native-foreground";

  let panel = null;
  let onPopupShowing = null;

  function parseRGB(color) {
    if (!color) return null;
    const match = color.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
    if (!match) return null;
    return {
      r: Math.max(0, Math.min(255, Number(match[1]))),
      g: Math.max(0, Math.min(255, Number(match[2]))),
      b: Math.max(0, Math.min(255, Number(match[3]))),
      a: match[4] == null ? 1 : Math.max(0, Math.min(1, Number(match[4]))),
    };
  }

  function opaqueRGB(color) {
    const rgb = parseRGB(color);
    if (!rgb) return color;
    return `rgb(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)})`;
  }

  function relativeLuminance({ r, g, b }) {
    const channel = (value) => {
      const s = value / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrastRatio(a, b) {
    const l1 = relativeLuminance(a);
    const l2 = relativeLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function ensureReadableForeground(foreground, background) {
    const fg = parseRGB(foreground);
    const bg = parseRGB(background);
    if (!fg || !bg || contrastRatio(fg, bg) >= 4.5) return foreground;

    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    return contrastRatio(black, bg) >= contrastRatio(white, bg)
      ? "rgb(0, 0, 0)"
      : "rgb(255, 255, 255)";
  }

  function isTransparent(color) {
    const rgb = parseRGB(color);
    return !color || color.trim().toLowerCase() === "transparent" || (rgb && rgb.a === 0);
  }

  function resolveToolbarBackground() {
    const toolbarBackground = document.getElementById("zen-toolbar-background");
    if (!toolbarBackground) return null;

    // The Zen theme variable is scoped to #zen-toolbar-background on modern Zen.
    // Resolve it *inside that element's inheritance tree* and then copy the
    // resulting ordinary background properties to the popup.
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "visibility:hidden",
      "width:1px",
      "height:1px",
      "inset:-10000px auto auto -10000px",
      "background:var(--zen-main-browser-background-toolbar, var(--toolbar-bgcolor, Menu))",
    ].join(";");

    toolbarBackground.appendChild(probe);
    const style = getComputedStyle(probe);
    let backgroundImage = style.backgroundImage || "none";
    let backgroundColor = style.backgroundColor || "transparent";
    probe.remove();

    // A popup is a separate native surface on some platforms. Letting a
    // translucent Zen toolbar color remain translucent here makes the webpage
    // underneath become the popup's effective background. Resolve an opaque
    // toolbar/system base, then keep Zen's gradient/image above it.
    const parsedBackground = parseRGB(backgroundColor);
    if (isTransparent(backgroundColor) || (parsedBackground && parsedBackground.a < 1)) {
      const rootProbe = document.createElement("div");
      rootProbe.setAttribute("aria-hidden", "true");
      rootProbe.style.cssText = [
        "position:fixed",
        "pointer-events:none",
        "visibility:hidden",
        "width:1px",
        "height:1px",
        "inset:-10000px auto auto -10000px",
        "background:var(--toolbar-bgcolor, Menu)",
      ].join(";");
      document.documentElement.appendChild(rootProbe);
      const fallbackStyle = getComputedStyle(rootProbe);
      let fallbackColor = fallbackStyle.backgroundColor;
      rootProbe.remove();

      if (isTransparent(fallbackColor)) {
        const menuProbe = document.createElement("div");
        menuProbe.style.cssText = "position:fixed;visibility:hidden;background:Menu";
        document.documentElement.appendChild(menuProbe);
        fallbackColor = getComputedStyle(menuProbe).backgroundColor;
        menuProbe.remove();
      }
      backgroundColor = opaqueRGB(fallbackColor || "rgb(255, 255, 255)");
    } else {
      backgroundColor = opaqueRGB(backgroundColor);
    }

    return { backgroundImage, backgroundColor };
  }

  function resolveToolbarForeground() {
    // Resolve Zen/Firefox's adaptive text variables into an ordinary rgb() value
    // inside the toolbar's own inheritance tree. Returning the raw custom
    // property would reintroduce the same scoping problem we are fixing for bg.
    const candidates = [
      document.getElementById("navigator-toolbox"),
      document.getElementById("zen-toolbar-background"),
      document.documentElement,
    ].filter(Boolean);

    for (const element of candidates) {
      const probe = document.createElement("div");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = [
        "position:fixed",
        "pointer-events:none",
        "visibility:hidden",
        "width:1px",
        "height:1px",
        "inset:-10000px auto auto -10000px",
        "color:var(--toolbox-textcolor, var(--toolbar-color, MenuText))",
      ].join(";");
      element.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      if (color) return color;
    }

    // Last native-looking fallback: an actually rendered tab label.
    const selectedLabel = window.gBrowser?.selectedTab?.querySelector?.(".tab-label");
    if (selectedLabel) {
      const color = getComputedStyle(selectedLabel).color;
      if (color) return color;
    }

    return "MenuText";
  }

  function syncPreviewColors() {
    if (!panel || !panel.isConnected) return;

    const background = resolveToolbarBackground();
    if (background) {
      panel.style.setProperty(BG_IMAGE_VAR, background.backgroundImage);
      panel.style.setProperty(BG_COLOR_VAR, background.backgroundColor);
    } else {
      panel.style.setProperty(BG_IMAGE_VAR, "none");
      panel.style.setProperty(BG_COLOR_VAR, "Menu");
    }

    const nativeForeground = resolveToolbarForeground();
    panel.style.setProperty(
      FG_VAR,
      ensureReadableForeground(nativeForeground, background?.backgroundColor || "rgb(255, 255, 255)"),
    );
  }

  function attach() {
    panel = document.getElementById(PANEL_ID);
    if (!panel) return false;

    onPopupShowing = () => syncPreviewColors();
    panel.addEventListener("popupshowing", onPopupShowing, true);
    syncPreviewColors();
    console.debug(`${LOG} native-color bridge active`);
    return true;
  }

  function detach() {
    if (panel && onPopupShowing) {
      panel.removeEventListener("popupshowing", onPopupShowing, true);
    }
    if (panel) {
      panel.style.removeProperty(BG_IMAGE_VAR);
      panel.style.removeProperty(BG_COLOR_VAR);
      panel.style.removeProperty(FG_VAR);
    }
    panel = null;
    onPopupShowing = null;
  }

  if (!attach()) {
    const observer = new MutationObserver(() => {
      if (attach()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    if (typeof window.addUnloadListener === "function") {
      window.addUnloadListener(() => {
        observer.disconnect();
        detach();
      });
    } else {
      window.addEventListener("unload", () => {
        observer.disconnect();
        detach();
      }, { once: true });
    }
  } else if (typeof window.addUnloadListener === "function") {
    window.addUnloadListener(detach);
  } else {
    window.addEventListener("unload", detach, { once: true });
  }
})();
