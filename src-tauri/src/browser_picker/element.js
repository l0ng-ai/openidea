// Runs at document start in the unprivileged picker. Only a physical click can fill the slot.
// The host reads the slot after a wake-up and validates its shape before showing the preview.
(() => {
  if (window !== window.top) return;
  let picked = null;
  const styleOf = window.getComputedStyle.bind(window);
  const encode = JSON.stringify;
  const post = window.ipc.postMessage.bind(window.ipc);
  Object.defineProperty(window, "__openideaPickedElement", { get: () => picked });
  let outline;
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof Element) || !document.body) return;
      if (!outline) {
        outline = document.createElement("div");
        outline.setAttribute("aria-hidden", "true");
        outline.style.cssText =
          "all:initial;position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #4d90fe";
        document.body.appendChild(outline);
      }
      const rect = event.target.getBoundingClientRect();
      Object.assign(outline.style, {
        left: rect.left + "px",
        top: rect.top + "px",
        width: rect.width + "px",
        height: rect.height + "px",
      });
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !event.isTrusted ||
        !event.isPrimary ||
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        picked !== null
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = event.target;
      const path = [];
      for (let node = element; node && path.length < 8; node = node.parentElement) {
        const tag = node.localName;
        let index = 1;
        for (
          let sibling = node.previousElementSibling;
          sibling && index < 65536;
          sibling = sibling.previousElementSibling
        )
          if (sibling.localName === tag) index++;
        if (index > 65535) return;
        path.unshift({ tag, index });
      }
      const css = styleOf(element);
      picked = encode({
        path,
        disabled: element.hasAttribute("disabled"),
        hidden: element.hasAttribute("hidden"),
        ariaDisabled: element.getAttribute("aria-disabled") === "true",
        display: css.display,
        position: css.position,
        visibility: css.visibility,
        pointerEvents: css.pointerEvents,
      });
      post("picked");
    },
    true,
  );
  // Suppress the click that follows the inspection gesture (links, form submits, app buttons).
  window.addEventListener(
    "click",
    (event) => {
      if (picked !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted && event.key === "Escape") {
        event.preventDefault();
        post("cancel");
      }
    },
    true,
  );
})();
